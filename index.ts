@Post('payments')
async handlePaymentWebhook(@Req() req, @Body() body): Promise<HttpStatus> {
  const rawBody = req.rawBody; // важно для подписи
  const signature = req.headers['x-signature'];

  // 1. Базовая валидация входа
  if (!body || !body.eventType || !body.data) {
    log.warn('Webhook invalid payload', { body });
    return 400; // 4xx — наш клиент прислал мусор
  }

  // 2. Проверка подписи/секрета
  const isValidSignature = this.signatureService.verify(rawBody, signature, process.env.WEBHOOK_SECRET);
  if (!isValidSignature) {
    // логируем, но не раскрываем детали
    log.warn('Webhook invalid signature', { eventType: body.eventType });
    return 400;
  }

  const externalEventId = body.id; // если есть
  const externalPaymentId = body.data.paymentId;
  const amount = body.data.amount;
  const currency = body.data.currency;
  const email = body.data.customerEmail; // может быть null
  const planId = body.data.planId;
  const eventType = body.eventType; // например, 'payment.succeeded'

  // 3. Сохраняем webhook_event как факт (вне транзакции бизнес-логики, но в БД)
  let webhookEvent: WebhookEvent;
  try {
    webhookEvent = await webhookEventsRepo.save({
      externalEventId,
      externalPaymentId,
      eventType,
      payload: body,
      signatureValid: true,
      status: 'received',
      receivedAt: new Date(),
    });
  } catch (e) {
    // если UNIQUE(external_event_id) сработал — это повтор
    if (isUniqueViolationOnExternalEventId(e)) {
      log.info('Duplicate webhook by external_event_id', { externalEventId });
      // Можно сразу вернуть 200, т.к. уже обработано ранее
      return 200;
    }
    log.error('Failed to persist webhook_event', { error: e });
    return 500; // не смогли даже записать событие
  }

  // 4. Дедупликация по external_payment_id (идемпотентность)
  // Если payment с таким external_payment_id уже есть и статус final — не делаем повторную бизнес-логику
  const existingPayment = await paymentsRepo.findOne({
    where: { externalPaymentId },
    relations: ['subscription'],
  });

  if (existingPayment && isFinalPaymentStatus(existingPayment.status)) {
    // помечаем webhook как duplicate
    await webhookEventsRepo.update(webhookEvent.id, {
      status: 'duplicate',
      processedAt: new Date(),
    });
    log.info('Duplicate webhook by external_payment_id', {
      externalPaymentId,
      paymentId: existingPayment.id,
    });
    return 200; // идемпотентный ответ
  }

  // 5. Транзакция бизнес-логики
  return await this.dataSource.transaction(async (manager) => {
    try {
      // 5.1 Обновляем статус webhook_event -> validated
      await manager.getRepository(WebhookEvent).update(webhookEvent.id, {
        status: 'validated',
      });

      // 5.2 Находим или создаем пользователя
      let user: User | null = null;

      if (email) {
        user = await manager.getRepository(User).findOne({ where: { email } });
        if (!user) {
          user = manager.getRepository(User).create({ email });
          user = await manager.getRepository(User).save(user);
        }
      } else {
        // нет email — можно:
        // - создать "анонимного" пользователя
        // - или отложить привязку (user_id = null)
        // Для простоты: создаем "technical" user, если есть другой идентификатор (customerId)
        const externalCustomerId = body.data.customerId;
        user = await this.userService.findOrCreateByExternalId(manager, externalCustomerId);
      }

      // 5.3 Находим или создаем подписку
      let subscription = await manager.getRepository(Subscription).findOne({
        where: { userId: user.id, planId, status: 'active' },
        lock: { mode: 'pessimistic_write' }, // защита от гонок
      });

      const now = new Date();
      const planDuration = this.planService.getDuration(planId); // например, 1 месяц

      if (!subscription) {
        // создаем новую подписку
        subscription = manager.getRepository(Subscription).create({
          userId: user.id,
          planId,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: addDuration(now, planDuration),
        });
        subscription = await manager.getRepository(Subscription).save(subscription);
      } else {
        // продлеваем подписку
        const baseDate =
          subscription.currentPeriodEnd > now ? subscription.currentPeriodEnd : now;
        subscription.currentPeriodEnd = addDuration(baseDate, planDuration);
        subscription.status = 'active';
        subscription = await manager.getRepository(Subscription).save(subscription);
      }

      // 5.4 Создаем или обновляем payment
      let payment: Payment;
      if (existingPayment) {
        // сервер мог упасть после создания payment, но до подписки
        payment = existingPayment;
        payment.userId = user.id;
        payment.subscriptionId = subscription.id;
        payment.status = mapEventTypeToPaymentStatus(eventType); // например, 'succeeded'
        payment.amount = amount;
        payment.currency = currency;
        payment.rawPayloadId = webhookEvent.id;
        payment.paidAt = body.data.paidAt || now;
        payment = await manager.getRepository(Payment).save(payment);
      } else {
        payment = manager.getRepository(Payment).create({
          userId: user.id,
          subscriptionId: subscription.id,
          externalPaymentId,
          externalEventId,
          amount,
          currency,
          status: mapEventTypeToPaymentStatus(eventType),
          rawPayloadId: webhookEvent.id,
          paidAt: body.data.paidAt || now,
        });
        payment = await manager.getRepository(Payment).save(payment);
      }

      // 5.5 Обновляем webhook_event -> processed
      await manager.getRepository(WebhookEvent).update(webhookEvent.id, {
        status: 'processed',
        processedAt: new Date(),
      });

      log.info('Webhook processed successfully', {
        webhookEventId: webhookEvent.id,
        paymentId: payment.id,
        subscriptionId: subscription.id,
        userId: user.id,
      });

      return 200;
    } catch (e) {
      // 5.6 Ошибка в транзакции — откат
      log.error('Webhook processing failed', {
        webhookEventId: webhookEvent.id,
        error: e,
      });
      await manager.getRepository(WebhookEvent).update(webhookEvent.id, {
        status: 'failed',
        errorMessage: serializeError(e),
      });
      // 5xx — чтобы провайдер мог ретраить
      throw new HttpException('Internal error', 500);
    }
  });
}
