CREATE TYPE "public"."context_source" AS ENUM('TEXT', 'UPLOAD', 'GENERATION');--> statement-breakpoint
CREATE TYPE "public"."model_capability" AS ENUM('TEXT', 'IMAGE', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PAID', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('HIGGSFIELD', 'OPENAI_COMPATIBLE');--> statement-breakpoint
CREATE TABLE "asset_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"model_id" uuid,
	"input_kinds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"structured" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text DEFAULT '' NOT NULL,
	"target_id" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"template" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"source" "context_source" DEFAULT 'TEXT' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"media_asset_id" uuid,
	"generation_id" uuid,
	"created_by_user_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"role" text DEFAULT 'REFERENCE' NOT NULL,
	"media_asset_id" uuid,
	"source_generation_id" uuid,
	"analysis_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"tokens" integer DEFAULT 0 NOT NULL,
	"plan_quota" integer DEFAULT 0 NOT NULL,
	"amount_rupiah" integer DEFAULT 0 NOT NULL,
	"provider" text DEFAULT 'MANUAL' NOT NULL,
	"provider_ref" text,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_storage" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"service_account_email" text DEFAULT '' NOT NULL,
	"private_key_encrypted" text DEFAULT '' NOT NULL,
	"folder_id" text DEFAULT '' NOT NULL,
	"connected_by_user_id" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "provider_model_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "input_capabilities" "model_capability"[] DEFAULT ARRAY['TEXT']::model_capability[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "output_capabilities" "model_capability"[] DEFAULT ARRAY['TEXT']::model_capability[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "sync_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "kind" "provider_kind" DEFAULT 'OPENAI_COMPATIBLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "is_fixed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "models_path" text DEFAULT '/models' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "supports_video_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "plan_mode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "final_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "analysis_snapshot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "pre_context_snapshot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "output_mime" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "output_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "driver" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_encrypted" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_analyses" ADD CONSTRAINT "asset_analyses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_analyses" ADD CONSTRAINT "asset_analyses_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_contexts" ADD CONSTRAINT "folder_contexts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_contexts" ADD CONSTRAINT "folder_contexts_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_contexts" ADD CONSTRAINT "folder_contexts_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_contexts" ADD CONSTRAINT "folder_contexts_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_contexts" ADD CONSTRAINT "folder_contexts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attachments" ADD CONSTRAINT "generation_attachments_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attachments" ADD CONSTRAINT "generation_attachments_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attachments" ADD CONSTRAINT "generation_attachments_source_generation_id_generations_id_fk" FOREIGN KEY ("source_generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_analyses_source_idx" ON "asset_analyses" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "folder_contexts_folder_created_idx" ON "folder_contexts" USING btree ("folder_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_attachments_generation_idx" ON "generation_attachments" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "orders_workspace_created_idx" ON "orders" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_provider_ref_idx" ON "orders" USING btree ("provider_ref");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_workspace_created_idx" ON "media_assets" USING btree ("workspace_id","created_at");--> statement-breakpoint
UPDATE "media_assets" SET "workspace_id" = g."workspace_id" FROM "generations" g WHERE "media_assets"."workspace_id" IS NULL AND g."output_url" LIKE '%' || "media_assets"."key";--> statement-breakpoint
UPDATE "ai_providers" SET "kind" = 'HIGGSFIELD', "is_fixed" = true, "models_path" = '/v1/models' WHERE "code" = 'HIGGSFIELD';--> statement-breakpoint
UPDATE "ai_models" SET "provider_model_id" = "code" WHERE "provider_model_id" = '';--> statement-breakpoint
UPDATE "ai_models" SET "source" = 'SYNC', "input_capabilities" = ARRAY['TEXT','IMAGE']::model_capability[], "output_capabilities" = ARRAY["media_type"::text]::model_capability[] WHERE "provider_id" IN (SELECT "id" FROM "ai_providers" WHERE "code" = 'HIGGSFIELD');
