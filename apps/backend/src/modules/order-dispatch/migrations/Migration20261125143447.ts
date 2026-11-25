import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261125143447 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "order_cancellation" add column if not exists "refund_verified_at" timestamptz null, add column if not exists "refund_checked_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "order_cancellation" drop column if exists "refund_verified_at", drop column if exists "refund_checked_at";`);
  }

}
