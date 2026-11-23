import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261123130347 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "late_razorpay_payment" drop constraint if exists "late_razorpay_payment_razorpay_payment_id_unique";`);
    this.addSql(`create table if not exists "late_razorpay_payment" ("id" text not null, "cart_id" text not null, "snapshot_id" text not null, "razorpay_order_id" text not null, "razorpay_payment_id" text not null, "amount_paise" integer not null, "currency_code" text not null, "status" text check ("status" in ('recovered', 'refunding', 'refunded', 'needs_review')) not null, "reason" text null, "order_id" text null, "refund_id" text null, "refund_attempts" integer not null default 0, "last_error" text null, "alerted_at" timestamptz null, "resolved_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "late_razorpay_payment_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_late_razorpay_payment_deleted_at" ON "late_razorpay_payment" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_late_razorpay_payment_cart_id" ON "late_razorpay_payment" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_late_razorpay_payment_razorpay_payment_id_unique" ON "late_razorpay_payment" ("razorpay_payment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_late_razorpay_payment_status" ON "late_razorpay_payment" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "payment_price_snapshot" add column if not exists "superseded_at" timestamptz null, add column if not exists "late_checked_at" timestamptz null;`);
    // Only the current attempt holds its session id, so a rebound session can take over an older attempt.
    this.addSql(`DROP INDEX IF EXISTS "IDX_payment_price_snapshot_payment_session_id_unique";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_payment_session_id_unique" ON "payment_price_snapshot" ("payment_session_id") WHERE deleted_at IS NULL AND superseded_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "late_razorpay_payment" cascade;`);

    this.addSql(`DROP INDEX IF EXISTS "IDX_payment_price_snapshot_payment_session_id_unique";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_payment_session_id_unique" ON "payment_price_snapshot" ("payment_session_id") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "payment_price_snapshot" drop column if exists "superseded_at", drop column if exists "late_checked_at";`);
  }

}
