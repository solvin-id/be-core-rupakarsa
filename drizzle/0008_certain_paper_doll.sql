ALTER TABLE "ai_character_references" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "character_reference_id" uuid;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "custom_reference_id" text;--> statement-breakpoint
ALTER TABLE "ai_character_references" ADD CONSTRAINT "ai_character_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_character_reference_id_ai_character_references_id_fk" FOREIGN KEY ("character_reference_id") REFERENCES "public"."ai_character_references"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_character_references_workspace_idx" ON "ai_character_references" USING btree ("workspace_id");