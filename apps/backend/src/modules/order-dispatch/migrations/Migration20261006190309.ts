import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006190309 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "order_dispatch" drop constraint if exists "order_dispatch_invoice_number_unique";`);
    this.addSql(`alter table if exists "order_dispatch" drop constraint if exists "order_dispatch_order_id_unique";`);
    this.addSql(`alter table if exists "invoice_counter" drop constraint if exists "invoice_counter_fy_unique";`);
    this.addSql(`create table if not exists "invoice_counter" ("id" text not null, "fy" text not null, "last_seq" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "invoice_counter_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_invoice_counter_deleted_at" ON "invoice_counter" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_invoice_counter_fy_unique" ON "invoice_counter" ("fy") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "order_dispatch" ("id" text not null, "order_id" text not null, "state" text check ("state" in ('placed', 'dispatching', 'dispatch_failed', 'shipped', 'cancelling', 'cancelled')) not null default 'placed', "window_ends_at" timestamptz not null, "dispatch_started_at" timestamptz null, "shipped_at" timestamptz null, "attempts" integer not null default 0, "next_attempt_at" timestamptz null, "last_error" text null, "shiprocket_order_ref" text null, "shiprocket_order_id" text null, "shiprocket_shipment_id" text null, "awb_code" text null, "courier_name" text null, "label_url" text null, "pickup_scheduled" boolean null, "invoice_fy" text null, "invoice_seq" integer null, "invoice_number" text null, "invoice_issued_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "order_dispatch_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_dispatch_deleted_at" ON "order_dispatch" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_dispatch_order_id_unique" ON "order_dispatch" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_dispatch_state_window_ends_at" ON "order_dispatch" ("state", "window_ends_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_dispatch_invoice_number_unique" ON "order_dispatch" ("invoice_number") WHERE invoice_number IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "invoice_counter" cascade;`);

    this.addSql(`drop table if exists "order_dispatch" cascade;`);
  }

}
