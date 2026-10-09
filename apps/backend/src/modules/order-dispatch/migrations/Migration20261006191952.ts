import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006191952 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "order_cancellation" drop constraint if exists "order_cancellation_order_id_unique";`);
    this.addSql(`create table if not exists "order_cancellation" ("id" text not null, "order_id" text not null, "requested_by" text check ("requested_by" in ('customer', 'staff')) not null default 'customer', "customer_id" text null, "reason" text null, "note" text null, "refund_method" text check ("refund_method" in ('wallet', 'original', 'none')) not null default 'none', "paid_online" numeric not null default 0, "wallet_used" numeric not null default 0, "fee" numeric not null default 0, "refund_amount" numeric not null default 0, "status" text check ("status" in ('processing', 'completed', 'needs_attention')) not null default 'processing', "refund_status" text check ("refund_status" in ('not_needed', 'pending', 'initiated', 'credited', 'failed', 'unverified')) not null default 'pending', "razorpay_refund_id" text null, "wallet_transaction_id" text null, "refund_error" text null, "cancelled_after_minutes" integer null, "completed_at" timestamptz null, "raw_paid_online" jsonb not null default '{"value":"0","precision":20}', "raw_wallet_used" jsonb not null default '{"value":"0","precision":20}', "raw_fee" jsonb not null default '{"value":"0","precision":20}', "raw_refund_amount" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "order_cancellation_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_cancellation_deleted_at" ON "order_cancellation" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_cancellation_order_id_unique" ON "order_cancellation" ("order_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "order_cancellation" cascade;`);
  }

}
