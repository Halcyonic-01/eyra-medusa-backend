import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261111133004 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "dispatch_override" drop constraint if exists "dispatch_override_order_id_unique";`);
    this.addSql(`create table if not exists "dispatch_override" ("id" text not null, "order_id" text not null, "actor_id" text not null, "reason" text not null, "held_reason" text not null, "revoked_at" timestamptz null, "revoked_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "dispatch_override_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_override_deleted_at" ON "dispatch_override" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_override_order_id" ON "dispatch_override" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_dispatch_override_order_id_unique" ON "dispatch_override" ("order_id") WHERE revoked_at IS NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "dispatch_override" cascade;`);
  }

}
