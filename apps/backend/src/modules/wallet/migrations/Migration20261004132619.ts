import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261004132619 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_type_check";`);
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_reason_check";`);

    this.addSql(`alter table if exists "wallet_transaction" add column if not exists "remaining" numeric not null default 0, add column if not exists "expires_at" timestamptz null, add column if not exists "metadata" jsonb null, add column if not exists "raw_remaining" jsonb not null default '{"value":"0","precision":20}';`);
    this.addSql(`alter table if exists "wallet_transaction" add constraint "wallet_transaction_type_check" check("type" in ('issued', 'redeemed', 'refunded', 'expired'));`);
    this.addSql(`alter table if exists "wallet_transaction" add constraint "wallet_transaction_reason_check" check("reason" in ('return', 'exchange', 'cancellation'));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_transaction_wallet_id_expires_at" ON "wallet_transaction" ("wallet_id", "expires_at") WHERE remaining > 0 AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_type_check";`);
    this.addSql(`alter table if exists "wallet_transaction" drop constraint if exists "wallet_transaction_reason_check";`);

    this.addSql(`drop index if exists "IDX_wallet_transaction_wallet_id_expires_at";`);
    this.addSql(`alter table if exists "wallet_transaction" drop column if exists "remaining", drop column if exists "expires_at", drop column if exists "metadata", drop column if exists "raw_remaining";`);

    this.addSql(`alter table if exists "wallet_transaction" add constraint "wallet_transaction_type_check" check("type" in ('issued', 'redeemed'));`);
    this.addSql(`alter table if exists "wallet_transaction" add constraint "wallet_transaction_reason_check" check("reason" in ('return', 'exchange'));`);
  }

}
