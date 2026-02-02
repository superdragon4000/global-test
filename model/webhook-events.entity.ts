import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

export enum WebhookEventStatus {
  RECEIVED = 'received',
  VALIDATED = 'validated',
  PROCESSED = 'processed',
  DUPLICATE = 'duplicate',
  FAILED = 'failed',
  IGNORED = 'ignored',
}

@Entity('webhook_events')
export class WebhookEvent extends BaseEntity {
  @Column({ type: 'varchar', nullable: true, unique: true })
  @Index({ unique: true })
  externalEventId: string | null;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  externalPaymentId: string | null;

  @Column({ type: 'varchar' })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: any;

  @Column({ type: 'boolean', default: false })
  signatureValid: boolean;

  @Column({
    type: 'enum',
    enum: WebhookEventStatus,
    default: WebhookEventStatus.RECEIVED,
  })
  status: WebhookEventStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamptz' })
  receivedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
