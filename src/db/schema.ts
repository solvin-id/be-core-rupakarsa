import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["USER", "SUPERADMIN"]);
export const workspaceRoleEnum = pgEnum("workspace_role", ["OWNER", "ADMIN", "MEMBER"]);
export const joinRequestStatusEnum = pgEnum("join_request_status", ["PENDING", "APPROVED", "REJECTED"]);
export const mediaTypeEnum = pgEnum("media_type", ["VIDEO", "IMAGE", "TEXT"]);
export const generationStatusEnum = pgEnum("generation_status", [
  "QUEUED",
  "RENDERING",
  "COMPLETED",
  "FAILED",
]);
export const ledgerTxTypeEnum = pgEnum("ledger_tx_type", [
  "TOPUP",
  "HOLD",
  "COMMIT",
  "REFUND",
  "ADJUSTMENT",
]);
export const providerKindEnum = pgEnum("provider_kind", ["HIGGSFIELD", "OPENAI_COMPATIBLE"]);
export const modelCapabilityEnum = pgEnum("model_capability", ["TEXT", "IMAGE", "VIDEO"]);
export const contextSourceEnum = pgEnum("context_source", ["TEXT", "UPLOAD", "GENERATION"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "SENT", "FAILED", "SKIPPED"]);
export const orderStatusEnum = pgEnum("order_status", ["PENDING", "PAID", "EXPIRED", "FAILED"]);

export type ModelCapability = "TEXT" | "IMAGE" | "VIDEO";

export interface ModelAllowedParams {
  durations?: number[];
  resolutions: string[];
  aspectRatios: string[];
}

export interface GenerationParams {
  durationSec?: number;
  resolution: string;
  aspectRatio: string;
}

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull().default(""),
  fullName: text("full_name").notNull(),
  role: userRoleEnum("role").notNull().default("USER"),
  cmsAccess: boolean("cms_access").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  defaultWorkspaceId: uuid("default_workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  totpSecretEncrypted: text("totp_secret_encrypted").notNull().default(""),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    tokenBalance: integer("token_balance").notNull().default(0),
    freePlanRemaining: integer("free_plan_remaining").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("workspaces_token_balance_check", sql`${table.tokenBalance} >= 0`),
    check("workspaces_free_plan_check", sql`${table.freePlanRemaining} >= 0`),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull().default("MEMBER"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_idx").on(table.workspaceId, table.userId),
    index("workspace_memberships_user_idx").on(table.userId),
  ],
);

export const workspaceJoinRequests = pgTable(
  "workspace_join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message").notNull().default(""),
    status: joinRequestStatusEnum("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("workspace_join_requests_workspace_status_idx").on(table.workspaceId, table.status)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("folders_workspace_updated_idx").on(table.workspaceId, table.updatedAt)],
);

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull().default(""),
  apiKeyEncrypted: text("api_key_encrypted").notNull().default(""),
  apiKeyMasked: text("api_key_masked").notNull().default(""),
  kind: providerKindEnum("kind").notNull().default("OPENAI_COMPATIBLE"),
  isFixed: boolean("is_fixed").notNull().default(false),
  modelsPath: text("models_path").notNull().default("/models"),
  supportsVideoInput: boolean("supports_video_input").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  syncError: text("sync_error"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiModels = pgTable(
  "ai_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => aiProviders.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    providerModelId: text("provider_model_id").notNull().default(""),
    mediaType: mediaTypeEnum("media_type").notNull(),
    inputCapabilities: modelCapabilityEnum("input_capabilities")
      .array()
      .notNull()
      .default(sql`ARRAY['TEXT']::model_capability[]`),
    outputCapabilities: modelCapabilityEnum("output_capabilities")
      .array()
      .notNull()
      .default(sql`ARRAY['TEXT']::model_capability[]`),
    source: text("source").notNull().default("MANUAL"),
    syncMetadata: jsonb("sync_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    allowedParams: jsonb("allowed_params").$type<ModelAllowedParams>().notNull(),
    tokenCost: integer("token_cost").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("ai_models_provider_code_idx").on(table.providerId, table.code),
    check("ai_models_token_cost_check", sql`${table.tokenCost} >= 0`),
  ],
);

export const generations = pgTable(
  "generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    modelId: uuid("model_id").references(() => aiModels.id, { onDelete: "set null" }),
    modelName: text("model_name").notNull().default(""),
    // Render outputs only: `generation-service.loadModel` rejects TEXT models before a row is written.
    mediaType: mediaTypeEnum("media_type").$type<"VIDEO" | "IMAGE">().notNull(),
    rawPrompt: text("raw_prompt").notNull(),
    plannedPrompt: text("planned_prompt").notNull().default(""),
    planMode: boolean("plan_mode").notNull().default(true),
    finalPrompt: text("final_prompt").notNull().default(""),
    analysisSnapshot: text("analysis_snapshot").notNull().default(""),
    preContextSnapshot: text("pre_context_snapshot").notNull().default(""),
    referenceImageUrl: text("reference_image_url"),
    selectedParams: jsonb("selected_params").$type<GenerationParams>().notNull(),
    tokensCharged: integer("tokens_charged").notNull().default(0),
    status: generationStatusEnum("status").notNull().default("QUEUED"),
    externalJobId: text("external_job_id"),
    outputUrl: text("output_url"),
    outputMime: text("output_mime"),
    outputSize: integer("output_size").notNull().default(0),
    errorMessage: text("error_message"),
    refunded: boolean("refunded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("generations_folder_created_idx").on(table.folderId, table.createdAt),
    index("generations_workspace_idx").on(table.workspaceId),
    index("generations_status_idx").on(table.status),
  ],
);

export const tokenLedger = pgTable(
  "token_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    generationId: uuid("generation_id").references(() => generations.id, { onDelete: "set null" }),
    txType: ledgerTxTypeEnum("tx_type").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("token_ledger_workspace_created_idx").on(table.workspaceId, table.createdAt)],
);

export const planUsages = pgTable(
  "plan_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    usedFreeQuota: boolean("used_free_quota").notNull(),
    tokensCharged: integer("tokens_charged").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("plan_usages_workspace_created_idx").on(table.workspaceId, table.createdAt)],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    key: text("key").notNull().unique(),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    driver: text("driver").notNull().default("local"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    checksum: text("checksum"),
    externalId: text("external_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("media_assets_workspace_created_idx").on(table.workspaceId, table.createdAt)],
);

export const folderContexts = pgTable(
  "folder_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    source: contextSourceEnum("source").notNull().default("TEXT"),
    label: text("label").notNull().default(""),
    text: text("text").notNull().default(""),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    generationId: uuid("generation_id").references(() => generations.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("folder_contexts_folder_created_idx").on(table.folderId, table.createdAt)],
);

export const assetAnalyses = pgTable(
  "asset_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    modelId: uuid("model_id").references(() => aiModels.id, { onDelete: "set null" }),
    inputKinds: text("input_kinds").array().notNull().default(sql`ARRAY[]::text[]`),
    text: text("text").notNull().default(""),
    structured: jsonb("structured")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("asset_analyses_source_idx").on(table.sourceKind, table.sourceId)],
);

export const generationAttachments = pgTable(
  "generation_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("REFERENCE"),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    sourceGenerationId: uuid("source_generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    analysisText: text("analysis_text").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("generation_attachments_generation_idx").on(table.generationId)],
);

export const workspaceStorage = pgTable("workspace_storage", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  googleEmail: text("google_email").notNull().default(""),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull().default(""),
  accessTokenEncrypted: text("access_token_encrypted").notNull().default(""),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  scope: text("scope").notNull().default(""),
  folderId: text("folder_id").notNull().default(""),
  folderName: text("folder_name").notNull().default("Rupakarsa"),
  connectedByUserId: uuid("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  requestedIp: text("requested_ip").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  template: text("template").notNull(),
  status: outboxStatusEnum("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    tokens: integer("tokens").notNull().default(0),
    planQuota: integer("plan_quota").notNull().default(0),
    amountRupiah: integer("amount_rupiah").notNull().default(0),
    provider: text("provider").notNull().default("MANUAL"),
    providerRef: text("provider_ref"),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("orders_workspace_created_idx").on(table.workspaceId, table.createdAt),
    uniqueIndex("orders_provider_ref_idx").on(table.providerRef),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull().default(""),
    targetId: text("target_id").notNull().default(""),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: text("ip").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMemberships),
  sessions: many(sessions),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  memberships: many(workspaceMemberships),
  folders: many(folders),
  generations: many(generations),
}));

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect;
export type WorkspaceJoinRequestRow = typeof workspaceJoinRequests.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type AiProviderRow = typeof aiProviders.$inferSelect;
export type AiModelRow = typeof aiModels.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type FolderContextRow = typeof folderContexts.$inferSelect;
export type AssetAnalysisRow = typeof assetAnalyses.$inferSelect;
export type GenerationAttachmentRow = typeof generationAttachments.$inferSelect;
export type WorkspaceStorageRow = typeof workspaceStorage.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type EmailOutboxRow = typeof emailOutbox.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
