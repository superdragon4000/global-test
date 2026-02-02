# Webhook платежей и подписка — Тестовое задание

## 1. Схема данных (PostgreSQL)

Ниже описаны 4 таблицы, их ключевые поля, уникальности, индексы и статусы.  
Цель — обеспечить идемпотентность, корректное продление подписки и восстановление после сбоев.

---

## 1.1 users

Минимальная таблица пользователя.

| Поле | Тип | Описание |
|------|------|----------|
| id | uuid PK | идентификатор |
| email | varchar, nullable, unique | может отсутствовать в webhook |
| external_customer_id | varchar, nullable, unique | ID клиента в платежной системе |
| created_at | timestamptz |  |
| updated_at | timestamptz |  |

### Уникальности
- `UNIQUE(email)` — один пользователь на email  
- `UNIQUE(external_customer_id)` — один пользователь на внешний ID  

### Индексы
- `INDEX(email)` — быстрый поиск  
- `INDEX(external_customer_id)` — быстрый поиск  

---

## 1.2 subscriptions

Одна активная подписка на пользователя и план.

| Поле | Тип | Описание |
|------|------|----------|
| id | uuid PK |  |
| user_id | uuid FK | владелец |
| plan_id | varchar | тариф |
| status | enum(active, expired, canceled, pending) | состояние |
| current_period_start | timestamptz | начало периода |
| current_period_end | timestamptz | конец периода |
| created_at | timestamptz |  |
| updated_at | timestamptz |  |

### Уникальности
- `UNIQUE(user_id, plan_id, status='active')`  
  → гарантирует **одну активную подписку**, исключает двойное продление.

### Индексы
- `INDEX(user_id)`  
- `INDEX(plan_id)`  

---

## 1.3 payments

Факт платежа.

| Поле | Тип | Описание |
|------|------|----------|
| id | uuid PK |  |
| user_id | uuid FK nullable | может быть создан до user |
| subscription_id | uuid FK nullable | может быть создан до подписки |
| external_payment_id | varchar unique | ID платежа в провайдере |
| external_event_id | varchar unique nullable | ID webhook события |
| amount | numeric | сумма |
| currency | varchar(3) | валюта |
| status | enum(pending, succeeded, failed, refunded, chargeback) | состояние |
| paid_at | timestamptz | время оплаты |
| created_at | timestamptz |  |
| updated_at | timestamptz |  |

### Уникальности
- `UNIQUE(external_payment_id)` — ключевая идемпотентность  
- `UNIQUE(external_event_id)` — защита от повторного webhook  

### Индексы
- `INDEX(user_id)`  
- `INDEX(subscription_id)`  
- `INDEX(status)`  

---

## 1.4 webhook_events

Храним каждый webhook для дебага и идемпотентности.

| Поле | Тип | Описание |
|------|------|----------|
| id | uuid PK |  |
| external_event_id | varchar unique nullable | ID события у провайдера |
| external_payment_id | varchar nullable | ID платежа |
| event_type | varchar | тип события |
| payload | jsonb | сырой webhook |
| signature_valid | boolean | проверка подписи |
| status | enum(received, validated, processed, duplicate, failed, ignored) | состояние |
| error_message | text nullable | ошибка |
| received_at | timestamptz |  |
| processed_at | timestamptz nullable |  |

### Уникальности
- `UNIQUE(external_event_id)` — защита от повторного webhook

### Индексы
- `INDEX(external_payment_id)`  
- `INDEX(status)`  

---

# 2. Пошаговый псевдокод обработчика webhook

Ниже — алгоритм, который гарантирует идемпотентность, корректное продление подписки и восстановление после падений.

---

## Псевдокод обработчика webhook

```pseudo
function handleWebhook(request):

    rawBody = request.rawBody
    signature = request.headers["x-signature"]
    body = request.json

    // 1. Валидация входа
    if body.id is empty OR body.eventType is empty OR body.data.paymentId is empty:
        return 400

    // 2. Проверка подписи
    if !verifySignature(rawBody, signature, SECRET):
        return 400

    externalEventId = body.id
    externalPaymentId = body.data.paymentId

    // 3. Сохраняем webhook_event
    try:
        insert webhook_event(status = received)
    catch unique_violation on external_event_id:
        return 200  // дубликат webhook

    // 4. Проверка дубликата платежа
    existingPayment = find payment by externalPaymentId

    if existingPayment exists AND existingPayment.status == succeeded:
        mark webhook_event as duplicate
        return 200

    // 5. Транзакция
    begin transaction:

        mark webhook_event as validated

        // 5.1 Находим или создаём user
        if email exists:
            user = find user by email
            if not found:
                create user
        else if customerId exists:
            user = find user by external_customer_id
            if not found:
                create user
        else:
            user = create technical user

        // 5.2 Находим или создаём подписку
        subscription = find active subscription(user, plan) FOR UPDATE

        if not found:
            create new subscription(
                status = active,
                period_start = now,
                period_end = now + plan_duration
            )
        else:
            base = max(now, subscription.current_period_end)
            subscription.current_period_end = base + plan_duration
            save subscription

        // 5.3 Создаём или обновляем payment
        if existingPayment exists:
            update payment with user_id, subscription_id, status = succeeded
        else:
            create payment with status = succeeded

        mark webhook_event as processed

    commit transaction

    return 200

catch any error:
    mark webhook_event as failed
    return 500

---
```
## Коды ответов

| Код | Когда | Почему |
|-----|--------|---------|
| **200** | успех или дубликат | провайдер не должен ретраить |
| **400** | неверная подпись, невалидный payload | ошибка отправителя |
| **500** | ошибка сервера, БД, транзакции | провайдер должен ретраить |

---

# 3. Edge cases

Коротко и по делу.

---

### Webhook пришёл дважды
- `UNIQUE(external_event_id)` → второй insert падает  
- `UNIQUE(external_payment_id)` → второй payment не создаётся  
- возвращаем `200 duplicate`

---

### Webhook пришёл раньше создания user
- создаём user по email или externalCustomerId  
- продолжаем обработку

---

### Webhook без email, но есть externalPaymentId
- создаём user по externalCustomerId  
- если нет customerId → создаём технического user  
- payment сохраняем, подписку активируем

---

### Webhook с другой суммой, чем план
- логируем mismatch  
- payment → failed  
- подписку не активируем  
- webhook_event → processed  
- возвращаем 200 (чтобы не было ретраев)

---

### Webhook пришёл через неделю
- используем paidAt из payload  
- продлеваем от `max(now, currentPeriodEnd)`  

---

### Сервер упал после записи payment, но до subscription
- при повторном webhook:
  - payment найден  
  - подписка не обновлена  
  - транзакция завершит обновление  
- дублей нет благодаря уникальным ключам

---

# 4. Debuggability и наблюдаемость

---

## 4.1 Что логируем обязательно

Для каждого webhook:

- request_id / correlation_id  
- webhook_event_id  
- external_event_id  
- external_payment_id  
- event_type  
- user_id, email  
- subscription_id, plan_id  
- payment_id, amount, currency, status  
- webhook_event.status  
- processing_time_ms  
- error_message (если есть)

Payload хранится в `webhook_events.payload`.

---

## 4.2 Метрики

### Счётчики
- `webhook_received_total{event_type}`
- `webhook_processed_total{status}`
- `webhook_failed_total`
- `payments_succeeded_total`
- `subscriptions_renewed_total`

### Латентность
- `webhook_processing_duration_ms`

### Ошибки
- `webhook_errors_total{reason}`

---

## 4.3 Алерты

- рост ошибок > X% за N минут  
- webhook_events в статусе `received` > N минут  
- нет активаций подписок при наличии платежей  
- mismatch amount  
- платежи без user/subscription  

---