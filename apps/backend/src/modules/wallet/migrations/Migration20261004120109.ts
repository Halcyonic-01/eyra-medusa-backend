import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261004120109 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_reference_unique";`);
    this.addSql(`alter table if exists "wallet" drop constraint if exists "wallet_customer_id_unique";`);
    this.addSql(`create table if not exists "wallet" ("id" text not null, "customer_id" text not null, "currency_code" text not null default 'inr', "balance" numeric not null default 0, "raw_balance" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "wallet_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wallet_customer_id_unique" ON "wallet" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_deleted_at" ON "wallet" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "wallet_transaction" ("id" text not null, "type" text check ("type" in ('issued', 'redeemed')) not null, "reason" text check ("reason" in ('return', 'exchange')) null, "amount" numeric not null, "balance_after" numeric not null, "order_id" text null, "reference" text null, "note" text null, "created_by" text null, "wallet_id" text not null, "raw_amount" jsonb not null, "raw_balance_after" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "wallet_transaction_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_transaction_wallet_id" ON "wallet_transaction" ("wallet_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_transaction_deleted_at" ON "wallet_transaction" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wallet_transaction_reference_unique" ON "wallet_transaction" ("reference") WHERE reference IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_transaction_order_id" ON "wallet_transaction" ("order_id") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "wallet_transaction" add constraint "wallet_transaction_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_wallet_id_foreign";`);

    this.addSql(`drop table if exists "wallet" cascade;`);

    this.addSql(`drop table if exists "wallet_transaction" cascade;`);
  }

}
