import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261116122043 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "return_request" add column if not exists "fee_refund_id" text null, add column if not exists "fee_refunded_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "return_request" drop column if exists "fee_refund_id", drop column if exists "fee_refunded_at";`);
  }

}
