CREATE TABLE "ai_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" uuid,
	"folder_id" uuid,
	"generation_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" uuid,
	"model_id" uuid,
	"model_name" text DEFAULT '' NOT NULL,
	"media_type" "media_type",
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"prompt_chars" integer DEFAULT 0 NOT NULL,
	"response_chars" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"external_job_id" text,
	"error_code" text,
	"error_message" text,
	"request_text" text DEFAULT '' NOT NULL,
	"response_text" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_character_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"model_version" text DEFAULT 'v1' NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'NOT_READY' NOT NULL,
	"thumbnail_url" text,
	"fail_reason" text,
	"input_image_urls" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "thinking_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "custom_reference_id" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "output_key" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "continuity_source_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_activity_logs" ADD CONSTRAINT "ai_activity_logs_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_character_references" ADD CONSTRAINT "ai_character_references_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_character_references" ADD CONSTRAINT "ai_character_references_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_activity_logs_created_idx" ON "ai_activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_activity_logs_workspace_created_idx" ON "ai_activity_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_activity_logs_kind_created_idx" ON "ai_activity_logs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "ai_activity_logs_status_created_idx" ON "ai_activity_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_activity_logs_generation_idx" ON "ai_activity_logs" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_character_references_external_idx" ON "ai_character_references" USING btree ("external_id");--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_continuity_source_id_generations_id_fk" FOREIGN KEY ("continuity_source_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

UPDATE "generations"
SET "output_key" = regexp_replace(substring("output_url" from 'workspaces/.*'), '\?.*$', '')
WHERE "output_key" IS NULL AND "output_url" LIKE '%workspaces/%';
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY folder_id ORDER BY created_at, id) AS seq
  FROM generations
)
UPDATE generations g SET sequence = r.seq FROM ranked r WHERE g.id = r.id;
--> statement-breakpoint
UPDATE ai_models SET max_prompt_chars = NULL WHERE max_prompt_chars = 0;
--> statement-breakpoint
UPDATE ai_providers SET base_url = 'https://api.higgsfield.ai', updated_at = now()
WHERE code = 'HIGGSFIELD'
  AND base_url IN ('https://platform.higgsfield.ai', 'https://platform.higgsfield.ai/');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "generations_folder_sequence_idx"
ON "generations" USING btree ("folder_id", "sequence");
