import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { hashPassword } from "../../src/auth/password.js";
import { createApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { seedPlatform } from "../../src/db/seed.js";
import { settleInlineRenders } from "../../src/queue/inline.js";
import { aiModels, users, workspaceMemberships, workspaces } from "../../src/db/schema.js";
import type { AiModelRow, UserRow, WorkspaceRow } from "../../src/db/schema.js";

export const TEST_PASSWORD = "rupakarsa";

export interface TestAccount {
  user: UserRow;
  workspace: WorkspaceRow;
  password: string;
}

export interface RequestOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

export interface TestClient {
  request(path: string, options?: RequestOptions): Promise<Response>;
  json<T>(path: string, options?: RequestOptions): Promise<{ status: number; body: T }>;
  cookie(): string;
  clearCookie(): void;
}

export interface CreateAccountInput {
  email: string;
  fullName?: string;
  password?: string;
  role?: "USER" | "SUPERADMIN";
  cmsAccess?: boolean;
  workspaceName?: string;
}

export async function resetDatabase(): Promise<void> {
  // The inline driver renders in the background; truncating under one deadlocks two transactions.
  await settleInlineRenders();
  await db.execute(sql`
    TRUNCATE TABLE
      users, workspaces, workspace_memberships, workspace_join_requests, sessions,
      folders, ai_providers, ai_models, generations, token_ledger, plan_usages,
      media_assets, app_settings, folder_contexts, asset_analyses, generation_attachments,
      ai_activity_logs, ai_character_references,
      workspace_storage, password_reset_tokens, email_outbox, orders, audit_logs
    RESTART IDENTITY CASCADE
  `);
  await db.transaction(async (tx) => seedPlatform(tx));
}

export async function createAccount(input: CreateAccountInput): Promise<TestAccount> {
  const password = input.password ?? TEST_PASSWORD;
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const slug = `${input.email.split("@")[0] ?? "studio"}-${userId.slice(0, 4)}`.toLowerCase();

  const created = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: workspaceId,
        name: input.workspaceName ?? `${input.fullName ?? "Test"} Workspace`,
        slug,
      })
      .returning();
    if (!workspace) throw new Error("Failed to create the test workspace.");

    const [user] = await tx
      .insert(users)
      .values({
        id: userId,
        email: input.email.toLowerCase(),
        passwordHash,
        fullName: input.fullName ?? "Test User",
        role: input.role ?? "USER",
        cmsAccess: input.cmsAccess ?? false,
        defaultWorkspaceId: workspace.id,
      })
      .returning();
    if (!user) throw new Error("Failed to create the test user.");

    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: user.id, role: "OWNER" });

    return { workspace, user };
  });

  return { ...created, password };
}

export async function addWorkspace(
  userId: string,
  input: { name: string; role: "OWNER" | "ADMIN" | "MEMBER"; tokenBalance?: number; freePlanRemaining?: number; isActive?: boolean },
): Promise<WorkspaceRow> {
  return await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`,
        tokenBalance: input.tokenBalance ?? 0,
        freePlanRemaining: input.freePlanRemaining ?? 0,
        isActive: input.isActive ?? true,
      })
      .returning();
    if (!workspace) throw new Error("Failed to create the workspace.");
    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId, role: input.role });
    return workspace;
  });
}

export async function addMember(
  workspaceId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "MEMBER",
): Promise<void> {
  await db.insert(workspaceMemberships).values({ workspaceId, userId, role });
}

export async function activateWorkspace(client: TestClient, workspaceId: string): Promise<void> {
  const response = await client.request(`/api/creator/workspaces/${workspaceId}/activate`, {
    method: "POST",
  });
  if (response.status !== 200) {
    throw new Error(`activate failed: ${response.status} ${await response.text()}`);
  }
}

export function createClient(): TestClient {
  const app = createApp();
  const jar = new Map<string, string>();

  function cookieHeader(): string {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  return {
    async request(path, options = {}) {
      const method = (options.method ?? "GET").toUpperCase();
      const headers = new Headers(options.headers ?? {});
      const cookie = cookieHeader();
      if (cookie) headers.set("cookie", cookie);

      // Double-submit CSRF: mirror the readable cookie unless the caller opts out.
      const csrf = jar.get("rupakarsa_csrf");
      if (csrf && !headers.has("x-csrf-token") && method !== "GET" && method !== "HEAD") {
        headers.set("x-csrf-token", csrf);
      }

      const response = await app.request(path, { ...options, headers });

      const setCookies = response.headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) {
        const [pair, ...attributes] = raw.split(";");
        if (!pair) continue;
        const [name, ...rest] = pair.split("=");
        if (!name) continue;
        const expired = attributes.some((attribute) => {
          const [key, value] = attribute.split("=");
          return key?.trim().toLowerCase() === "max-age" && value?.trim() === "0";
        });
        if (expired) {
          jar.delete(name.trim());
          continue;
        }
        jar.set(name.trim(), rest.join("="));
      }

      return response;
    },
    async json<T>(path: string, options: RequestOptions = {}) {
      const response = await this.request(path, options);
      const text = await response.text();
      return {
        status: response.status,
        body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
      };
    },
    cookie() {
      return cookieHeader();
    },
    clearCookie() {
      jar.clear();
    },
  };
}

export function jsonBody(body: unknown): RequestOptions {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Reads `{ error: { message } }` from a raw Response without trusting an unchecked cast. */
export async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return "";
}

export async function login(client: TestClient, email: string, password = TEST_PASSWORD) {
  const response = await client.json<{ workspace: WorkspaceRow; user: UserRow }>(
    "/api/creator/auth/login",
    jsonBody({ email, password }),
  );
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function modelByCode(code: string): Promise<AiModelRow> {
  const rows = await db.select().from(aiModels);
  const model = rows.find((row) => row.code === code);
  if (!model) throw new Error(`Missing model ${code}`);
  return model;
}

export async function createFolder(client: TestClient, name = "Folder Uji"): Promise<{ id: string }> {
  const response = await client.json<{ id: string }>("/api/creator/folders", jsonBody({ name }));
  if (response.status !== 201) {
    throw new Error(`folder create failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function pollGeneration(
  client: TestClient,
  generationId: string,
  statuses: readonly string[],
  timeoutMs = 15_000,
): Promise<{ status: string; outputUrl: string | null; refunded: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.json<{
      status: string;
      outputUrl: string | null;
      refunded: boolean;
    }>(`/api/creator/generations/${generationId}`);
    if (response.status === 200 && statuses.includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`generation ${generationId} did not reach ${statuses.join("/")} in time`);
}
