import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261125143510 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "payment_webhook_event" drop constraint if exists "payment_webhook_event_provider_id_event_key_unique";`);
    this.addSql(`create table if not exists "payment_webhook_event" ("id" text not null, "provider_id" text not null, "event_key" text not null, "event_type" text not null, "provider_event_id" text null, "attempt_ref" text null, "cart_id" text null, "outcome" text check ("outcome" in ('forwarded', 'settling')) not null, "deliveries" integer not null default 1, "duplicates" integer not null default 0, "forwarded_at" timestamptz not null, "last_seen_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_webhook_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_webhook_event_deleted_at" ON "payment_webhook_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_webhook_event_provider_id_event_key_unique" ON "payment_webhook_event" ("provider_id", "event_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_webhook_event_cart_id" ON "payment_webhook_event" ("cart_id") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "late_razorpay_payment" add column if not exists "refund_verified_at" timestamptz null, add column if not exists "refund_checked_at" timestamptz null;`);

    this.addSql(`alter table if exists "payment_price_snapshot" add column if not exists "reconciled_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "payment_webhook_event" cascade;`);

    this.addSql(`alter table if exists "late_razorpay_payment" drop column if exists "refund_verified_at", drop column if exists "refund_checked_at";`);

    this.addSql(`alter table if exists "payment_price_snapshot" drop column if exists "reconciled_at";`);
  }

}
