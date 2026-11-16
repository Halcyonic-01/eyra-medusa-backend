import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261113135118 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_notification" drop constraint if exists "review_notification_request_id_stage_channel_unique";`);
    this.addSql(`alter table if exists "review_request" drop constraint if exists "review_request_token_hash_unique";`);
    this.addSql(`alter table if exists "review_request" drop constraint if exists "review_request_order_id_unique";`);
    this.addSql(`alter table if exists "product_review" drop constraint if exists "product_review_product_id_customer_key_unique";`);
    this.addSql(`create table if not exists "product_review" ("id" text not null, "product_id" text not null, "variant_id" text null, "order_id" text not null, "line_item_id" text not null, "customer_id" text null, "customer_email" text null, "customer_key" text not null, "rating" integer not null, "title" text null, "body" text not null, "display_name" text not null, "product_title" text null, "variant_title" text null, "status" text check ("status" in ('pending', 'approved', 'rejected')) not null default 'pending', "verified_purchase" boolean not null default true, "source" text check ("source" in ('link', 'account')) not null, "flags" jsonb null, "rejection_reason" text check ("rejection_reason" in ('spam', 'abusive', 'personal_information', 'off_topic', 'not_genuine', 'inappropriate_photo')) null, "moderation_note" text null, "moderated_by" text null, "moderated_at" timestamptz null, "submitted_at" timestamptz not null, "edited_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "product_review_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_review_deleted_at" ON "product_review" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_review_product_id_customer_key_unique" ON "product_review" ("product_id", "customer_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_review_product_id_status" ON "product_review" ("product_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_review_status" ON "product_review" ("status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_review_order_id" ON "product_review" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_review_customer_id" ON "product_review" ("customer_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "review_photo" ("id" text not null, "order_id" text not null, "file_id" text not null, "url" text not null, "mime_type" text not null, "size" integer not null, "status" text check ("status" in ('uploaded', 'attached', 'removed')) not null default 'uploaded', "review_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_photo_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_photo_review_id" ON "review_photo" ("review_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_photo_deleted_at" ON "review_photo" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_photo_order_id" ON "review_photo" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_photo_status" ON "review_photo" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "review_request" ("id" text not null, "order_id" text not null, "customer_id" text null, "email" text null, "phone" text null, "first_name" text null, "whatsapp_opt_in" boolean not null default false, "delivered_at" timestamptz null, "token_nonce" text not null, "token_hash" text not null, "token_expires_at" timestamptz not null, "token_used_at" timestamptz null, "opened_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_request_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_request_deleted_at" ON "review_request" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_request_order_id_unique" ON "review_request" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_request_token_hash_unique" ON "review_request" ("token_hash") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "review_notification" ("id" text not null, "stage" text check ("stage" in ('request', 'reminder')) not null, "channel" text check ("channel" in ('email', 'whatsapp')) not null, "status" text check ("status" in ('scheduled', 'pending', 'sending', 'sent', 'failed', 'gave_up', 'skipped', 'cancelled')) not null, "due_at" timestamptz not null, "attempts" integer not null default 0, "claimed_at" timestamptz null, "next_attempt_at" timestamptz null, "sent_at" timestamptz null, "detail" text null, "request_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_notification_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_notification_request_id" ON "review_notification" ("request_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_notification_deleted_at" ON "review_notification" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_notification_request_id_stage_channel_unique" ON "review_notification" ("request_id", "stage", "channel") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_notification_status_due_at" ON "review_notification" ("status", "due_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "review_photo" add constraint "review_photo_review_id_foreign" foreign key ("review_id") references "product_review" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "review_notification" add constraint "review_notification_request_id_foreign" foreign key ("request_id") references "review_request" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "review_photo" drop constraint if exists "review_photo_review_id_foreign";`);

    this.addSql(`alter table if exists "review_notification" drop constraint if exists "review_notification_request_id_foreign";`);

    this.addSql(`drop table if exists "product_review" cascade;`);

    this.addSql(`drop table if exists "review_photo" cascade;`);

    this.addSql(`drop table if exists "review_request" cascade;`);

    this.addSql(`drop table if exists "review_notification" cascade;`);
  }

}
