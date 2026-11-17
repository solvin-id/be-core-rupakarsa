ALTER TABLE "ai_models" ADD COLUMN "max_prompt_chars" integer;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "prompt_compressed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "prompt_limit_chars" integer;