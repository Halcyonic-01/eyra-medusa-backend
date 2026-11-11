import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261111110002 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "payment_price_snapshot" drop constraint if exists "payment_price_snapshot_razorpay_order_id_unique";`);
    this.addSql(`alter table if exists "payment_price_snapshot" drop constraint if exists "payment_price_snapshot_payment_session_id_unique";`);
    this.addSql(`create table if not exists "payment_price_snapshot" ("id" text not null, "cart_id" text not null, "payment_collection_id" text not null, "payment_session_id" text not null, "provider_id" text not null, "razorpay_order_id" text not null, "currency_code" text not null, "amount_paise" integer not null, "razorpay_amount_paise" integer not null, "lines" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_price_snapshot_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_deleted_at" ON "payment_price_snapshot" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_cart_id" ON "payment_price_snapshot" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_payment_session_id_unique" ON "payment_price_snapshot" ("payment_session_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_razorpay_order_id_unique" ON "payment_price_snapshot" ("razorpay_order_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "payment_price_snapshot" cascade;`);
  }

}
