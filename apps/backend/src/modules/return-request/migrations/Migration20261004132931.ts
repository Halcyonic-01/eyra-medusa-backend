import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261004132931 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "return_request" ("id" text not null, "order_id" text not null, "customer_id" text not null, "type" text check ("type" in ('return', 'exchange')) not null, "reason" text check ("reason" in ('wrong_size', 'damaged_or_defective', 'not_as_described', 'changed_mind', 'other')) not null, "note" text null, "items" jsonb not null, "status" text check ("status" in ('pending', 'approved', 'rejected')) not null default 'pending', "credit_amount" numeric null, "resolution_note" text null, "resolved_by" text null, "resolved_at" timestamptz null, "raw_credit_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "return_request_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_return_request_deleted_at" ON "return_request" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_return_request_order_id" ON "return_request" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_return_request_customer_id" ON "return_request" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_return_request_status" ON "return_request" ("status") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "return_request" cascade;`);
  }

}
