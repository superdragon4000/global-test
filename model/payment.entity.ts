import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { User } from '../users/user.entity';
import { Subscription } from '../subscriptions/subscription.entity';

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CHARGEBACK = 'chargeback',
}

@Entity('payments')
export class Payment extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  @Index()
  userId: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  subscriptionId: string | null;

  @ManyToOne(() => Subscription)
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription | null;

  @Column({ type: 'varchar', unique: true })
  @Index({ unique: true })
  externalPaymentId: string;

  @Column({ type: 'varchar', nullable: true, unique: true })
  externalEventId: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Column({ type: 'uuid', nullable: true })
  rawPayloadId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;
}
