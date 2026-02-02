import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ type: 'varchar', nullable: true, unique: true })
  @Index()
  email: string | null;

  @Column({ type: 'varchar', nullable: true, unique: true })
  @Index()
  externalCustomerId: string | null;
}
