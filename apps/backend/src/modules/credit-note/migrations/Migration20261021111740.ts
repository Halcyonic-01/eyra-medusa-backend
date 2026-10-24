import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261021111740 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "credit_note_counter" drop constraint if exists "credit_note_counter_fy_unique";`);
    this.addSql(`alter table if exists "credit_note" drop constraint if exists "credit_note_source_key_unique";`);
    this.addSql(`alter table if exists "credit_note" drop constraint if exists "credit_note_credit_note_number_unique";`);
    this.addSql(`create table if not exists "credit_note" ("id" text not null, "credit_note_number" text not null, "fy" text not null, "seq" integer not null, "source_key" text not null, "kind" text check ("kind" in ('return', 'exchange', 'cancellation', 'rto')) not null, "order_id" text not null, "return_request_id" text null, "original_invoice_number" text not null, "original_invoice_date" text not null, "issued_at" timestamptz not null, "gstr1_period" text not null, "taxable_paise" integer not null, "cgst_paise" integer not null, "sgst_paise" integer not null, "igst_paise" integer not null, "total_paise" integer not null, "deduction_paise" integer not null default 0, "net_credit_paise" integer not null, "payload" jsonb not null, "pdf_key" text null, "pdf_sha256" text null, "pdf_attempts" integer not null default 0, "pdf_retry_at" timestamptz null, "pdf_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "credit_note_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_credit_note_deleted_at" ON "credit_note" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_credit_note_credit_note_number_unique" ON "credit_note" ("credit_note_number") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_credit_note_source_key_unique" ON "credit_note" ("source_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_credit_note_order_id" ON "credit_note" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_credit_note_gstr1_period" ON "credit_note" ("gstr1_period") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "credit_note_counter" ("id" text not null, "fy" text not null, "last_seq" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "credit_note_counter_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_credit_note_counter_deleted_at" ON "credit_note_counter" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_credit_note_counter_fy_unique" ON "credit_note_counter" ("fy") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "credit_note" cascade;`);

    this.addSql(`drop table if exists "credit_note_counter" cascade;`);
  }

}
