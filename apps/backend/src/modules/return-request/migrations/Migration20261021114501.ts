import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261021114501 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_reverse_order_ref_unique";`);
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_fee_link_id_unique";`);
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_reason_check";`);
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_status_check";`);

    this.addSql(`alter table if exists "return_request" add column if not exists "delivered_at" timestamptz null, add column if not exists "paid_value" numeric null, add column if not exists "fee_amount" numeric null, add column if not exists "reverse_order_ref" text null, add column if not exists "reverse_shipment_id" text null, add column if not exists "reverse_awb" text null, add column if not exists "reverse_requested_at" timestamptz null, add column if not exists "reverse_error" text null, add column if not exists "replacement_variant_id" text null, add column if not exists "replacement_title" text null, add column if not exists "replacement_price" numeric null, add column if not exists "price_difference" numeric null, add column if not exists "amount_due" numeric null, add column if not exists "fee_link_id" text null, add column if not exists "fee_link_url" text null, add column if not exists "fee_paid_at" timestamptz null, add column if not exists "fee_payment_id" text null, add column if not exists "replacement_order_id" text null, add column if not exists "credit_note_id" text null, add column if not exists "received_at" timestamptz null, add column if not exists "received_by" text null, add column if not exists "raw_paid_value" jsonb null, add column if not exists "raw_fee_amount" jsonb null, add column if not exists "raw_replacement_price" jsonb null, add column if not exists "raw_price_difference" jsonb null, add column if not exists "raw_amount_due" jsonb null;`);
    this.addSql(`alter table if exists "return_request" add constraint "return_request_reason_check" check("reason" in ('SIZE_ISSUE', 'DESIGN_PREFERENCE', 'DAMAGED_IN_TRANSIT', 'DEFECTIVE', 'wrong_size', 'damaged_or_defective', 'not_as_described', 'changed_mind', 'other'));`);
    this.addSql(`alter table if exists "return_request" add constraint "return_request_status_check" check("status" in ('pending', 'pending_fee', 'reverse_pickup_scheduled', 'awaiting_inspection', 'approved', 'rejected'));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_return_request_fee_link_id_unique" ON "return_request" ("fee_link_id") WHERE fee_link_id IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_return_request_reverse_order_ref_unique" ON "return_request" ("reverse_order_ref") WHERE reverse_order_ref IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_return_request_reverse_awb" ON "return_request" ("reverse_awb") WHERE reverse_awb IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_reason_check";`);
    this.addSql(`alter table if exists "return_request" drop constraint if exists "return_request_status_check";`);

    this.addSql(`drop index if exists "IDX_return_request_fee_link_id_unique";`);
    this.addSql(`drop index if exists "IDX_return_request_reverse_order_ref_unique";`);
    this.addSql(`drop index if exists "IDX_return_request_reverse_awb";`);
    this.addSql(`alter table if exists "return_request" drop column if exists "delivered_at", drop column if exists "paid_value", drop column if exists "fee_amount", drop column if exists "reverse_order_ref", drop column if exists "reverse_shipment_id", drop column if exists "reverse_awb", drop column if exists "reverse_requested_at", drop column if exists "reverse_error", drop column if exists "replacement_variant_id", drop column if exists "replacement_title", drop column if exists "replacement_price", drop column if exists "price_difference", drop column if exists "amount_due", drop column if exists "fee_link_id", drop column if exists "fee_link_url", drop column if exists "fee_paid_at", drop column if exists "fee_payment_id", drop column if exists "replacement_order_id", drop column if exists "credit_note_id", drop column if exists "received_at", drop column if exists "received_by", drop column if exists "raw_paid_value", drop column if exists "raw_fee_amount", drop column if exists "raw_replacement_price", drop column if exists "raw_price_difference", drop column if exists "raw_amount_due";`);

    this.addSql(`alter table if exists "return_request" add constraint "return_request_reason_check" check("reason" in ('wrong_size', 'damaged_or_defective', 'not_as_described', 'changed_mind', 'other'));`);
    this.addSql(`alter table if exists "return_request" add constraint "return_request_status_check" check("status" in ('pending', 'approved', 'rejected'));`);
  }

}
