import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261123145803 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "payment_price_snapshot" drop constraint if exists "payment_price_snapshot_provider_id_provider_ref_unique";`);
    this.addSql(`alter table if exists "late_razorpay_payment" drop constraint if exists "late_razorpay_payment_provider_id_provider_payment_ref_unique";`);
    this.addSql(`alter table if exists "late_razorpay_payment" add column if not exists "provider_id" text not null default 'pp_razorpay_razorpay', add column if not exists "provider_ref" text null, add column if not exists "provider_payment_ref" text null;`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_order_id" type text using ("razorpay_order_id"::text);`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_order_id" drop not null;`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_payment_id" type text using ("razorpay_payment_id"::text);`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_payment_id" drop not null;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_late_razorpay_payment_provider_id_provider_payment_ref_unique" ON "late_razorpay_payment" ("provider_id", "provider_payment_ref") WHERE deleted_at IS NULL AND provider_payment_ref IS NOT NULL;`);

    this.addSql(`alter table if exists "payment_price_snapshot" add column if not exists "provider_ref" text null, add column if not exists "provider_amount_paise" integer null;`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_order_id" type text using ("razorpay_order_id"::text);`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_order_id" drop not null;`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_amount_paise" type integer using ("razorpay_amount_paise"::integer);`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_amount_paise" drop not null;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_price_snapshot_provider_id_provider_ref_unique" ON "payment_price_snapshot" ("provider_id", "provider_ref") WHERE deleted_at IS NULL AND provider_ref IS NOT NULL;`);

    // Existing rows are all Razorpay: copy their ids into the provider columns.
    this.addSql(`update "payment_price_snapshot" set "provider_ref" = "razorpay_order_id", "provider_amount_paise" = "razorpay_amount_paise" where "provider_ref" is null and "razorpay_order_id" is not null;`);
    this.addSql(`update "late_razorpay_payment" set "provider_ref" = "razorpay_order_id", "provider_payment_ref" = "razorpay_payment_id" where "provider_payment_ref" is null and "razorpay_payment_id" is not null;`);
  }

  // Down puts NOT NULL back on the Razorpay columns, so it fails while rows of another provider exist.
  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_late_razorpay_payment_provider_id_provider_payment_ref_unique";`);
    this.addSql(`alter table if exists "late_razorpay_payment" drop column if exists "provider_id", drop column if exists "provider_ref", drop column if exists "provider_payment_ref";`);

    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_order_id" type text using ("razorpay_order_id"::text);`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_order_id" set not null;`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_payment_id" type text using ("razorpay_payment_id"::text);`);
    this.addSql(`alter table if exists "late_razorpay_payment" alter column "razorpay_payment_id" set not null;`);

    this.addSql(`drop index if exists "IDX_payment_price_snapshot_provider_id_provider_ref_unique";`);
    this.addSql(`alter table if exists "payment_price_snapshot" drop column if exists "provider_ref", drop column if exists "provider_amount_paise";`);

    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_order_id" type text using ("razorpay_order_id"::text);`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_order_id" set not null;`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_amount_paise" type integer using ("razorpay_amount_paise"::integer);`);
    this.addSql(`alter table if exists "payment_price_snapshot" alter column "razorpay_amount_paise" set not null;`);
  }

}
