import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261021112553 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "order_dispatch" add column if not exists "shiprocket_status" text null, add column if not exists "shiprocket_status_at" timestamptz null, add column if not exists "delivery_attempted_at" timestamptz null, add column if not exists "delivered_at" timestamptz null, add column if not exists "rto_initiated_at" timestamptz null, add column if not exists "rto_delivered_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "order_dispatch" drop column if exists "shiprocket_status", drop column if exists "shiprocket_status_at", drop column if exists "delivery_attempted_at", drop column if exists "delivered_at", drop column if exists "rto_initiated_at", drop column if exists "rto_delivered_at";`);
  }

}
