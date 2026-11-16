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
export const mediaTypeEnum = pgEnum("media_type", ["VIDEO", "IMAGE"]);
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
    mediaType: mediaTypeEnum("media_type").notNull(),
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
    mediaType: mediaTypeEnum("media_type").notNull(),
    rawPrompt: text("raw_prompt").notNull(),
    plannedPrompt: text("planned_prompt").notNull().default(""),
    referenceImageUrl: text("reference_image_url"),
    selectedParams: jsonb("selected_params").$type<GenerationParams>().notNull(),
    tokensCharged: integer("tokens_charged").notNull().default(0),
    status: generationStatusEnum("status").notNull().default("QUEUED"),
    externalJobId: text("external_job_id"),
    outputUrl: text("output_url"),
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

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  mime: text("mime").notNull(),
  size: integer("size").notNull().default(0),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
