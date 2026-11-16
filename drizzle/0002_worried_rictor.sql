-- Service-account Drive credentials are replaced by per-workspace OAuth tokens; existing rows must reconnect.
ALTER TABLE "workspace_storage" ADD COLUMN "google_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "refresh_token_encrypted" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "access_token_encrypted" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "folder_name" text DEFAULT 'Rupakarsa' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "service_account_email";--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "private_key_encrypted";