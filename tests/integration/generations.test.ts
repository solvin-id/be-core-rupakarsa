import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { planUsages, tokenLedger, workspaces } from "../../src/db/schema.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  pollGeneration,
  readErrorMessage,
  resetDatabase,
} from "./helpers.js";
import type { TestAccount, TestClient } from "./helpers.js";

interface GenerationBody {
  id: string;
  status: string;
  outputUrl: string | null;
  refunded: boolean;
  tokensCharged: number;
}

async function setBalances(
  workspaceId: string,
  input: { tokens: number; freePlan?: number },
): Promise<void> {
  await db
    .update(workspaces)
    .set({ tokenBalance: input.tokens, freePlanRemaining: input.freePlan ?? 0 })
    .where(eq(workspaces.id, workspaceId));
}

async function balanceOf(workspaceId: string): Promise<{ tokens: number; plan: number }> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return { tokens: row?.tokenBalance ?? -1, plan: row?.freePlanRemaining ?? -1 };
}

async function prepare(
  email = "creator@example.test",
  input: { tokens?: number; freePlan?: number } = {},
): Promise<{ account: TestAccount; client: TestClient }> {
  const account = await createAccount({ email });
  await setBalances(account.workspace.id, {
    tokens: input.tokens ?? 100,
    freePlan: input.freePlan ?? 0,
  });
  const client = createClient();
  await login(client, email);
  return { account, client };
}

describe("generation pipeline", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("charges the free plan quota before any token", async () => {
    const { account, client } = await prepare("plan@example.test", { tokens: 50, freePlan: 1 });
    const model = await modelByCode("wan-qwen-10s");

    const response = await client.json<{
      blueprint: { prompt: string; direction: string; negativePrompt: string };
      cost: { tokens: number; usesFreeQuota: boolean };
      workspace: { tokenBalance: number; freePlanRemaining: number };
    }>(
      "/api/creator/generations/plan",
      jsonBody({
        modelId: model.id,
        rawPrompt: "Uji plan",
        durationSec: 10,
        resolution: "1080p",
        aspectRatio: "16:9",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body.blueprint.prompt).toContain("[SUBJECT] Uji plan");
    expect(response.body.blueprint.prompt).toContain("Duration: 10 seconds.");
    expect(response.body.cost).toEqual({ tokens: 0, usesFreeQuota: true });
    expect(response.body.workspace.freePlanRemaining).toBe(0);
    expect(response.body.workspace.tokenBalance).toBe(50);

    const holds = await db.select().from(tokenLedger).where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(holds).toHaveLength(0);

    const usage = await db.select().from(planUsages).where(eq(planUsages.workspaceId, account.workspace.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.usedFreeQuota).toBe(true);
  });

  it("charges one token per plan once the free quota is gone", async () => {
    const { account, client } = await prepare("plan2@example.test", { tokens: 50, freePlan: 0 });
    const model = await modelByCode("flux-image");

    const response = await client.json<{ cost: { tokens: number; usesFreeQuota: boolean } }>(
      "/api/creator/generations/plan",
      jsonBody({
        modelId: model.id,
        rawPrompt: "Still life rempah",
        resolution: "2k",
        aspectRatio: "4:5",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body.cost).toEqual({ tokens: 1, usesFreeQuota: false });
    expect((await balanceOf(account.workspace.id)).tokens).toBe(49);

    const ledger = await db.select().from(tokenLedger).where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(ledger.map((row) => row.txType).sort()).toEqual(["COMMIT", "HOLD"]);
    expect(ledger.find((row) => row.txType === "HOLD")?.amount).toBe(-1);
  });

  it("holds tokens, renders inline, serves the poster and commits the hold", async () => {
    const { account, client } = await prepare("render@example.test", { tokens: 100 });
    const model = await modelByCode("wan-qwen-10s");
    const folder = await createFolder(client, "Kampanye Rasa");

    const created = await client.json<{ generation: GenerationBody; workspace: { tokenBalance: number } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Uap rendang",
        plannedPrompt: "[SUBJECT] Uap rendang",
        selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );

    expect(created.status).toBe(201);
    expect(created.body.generation.status).toBe("QUEUED");
    expect(created.body.generation.tokensCharged).toBe(35);
    expect(created.body.workspace.tokenBalance).toBe(65);

    const finished = await pollGeneration(client, created.body.generation.id, ["COMPLETED", "FAILED"]);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.outputUrl).toContain("/media/generations/");

    const balance = await balanceOf(account.workspace.id);
    expect(balance.tokens).toBe(65);

    const ledger = await db.select().from(tokenLedger).where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(ledger.map((row) => row.txType).sort()).toEqual(["COMMIT", "HOLD"]);
    expect(ledger.find((row) => row.txType === "HOLD")?.amount).toBe(-35);

    const key = finished.outputUrl?.split("/media/")[1] ?? "";
    const media = await client.request(`/media/${key}`);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/svg+xml");
    expect(media.headers.get("cache-control")).toContain("immutable");

    const download = await client.request(`/media/${key}?download=1`);
    expect(download.headers.get("content-disposition")).toContain("attachment");

    const listed = await client.json<Array<{ id: string; status: string }>>(
      `/api/creator/folders/${folder.id}/generations`,
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.status).toBe("COMPLETED");

    const stats = await client.json<Array<{ videoCount: number; imageCount: number; tokensUsed: number }>>(
      "/api/creator/folders",
    );
    expect(stats.body[0]).toMatchObject({ videoCount: 1, imageCount: 0, tokensUsed: 35 });
  });

  it("refunds a simulated provider failure", async () => {
    const { account, client } = await prepare("fail@example.test", { tokens: 80 });
    const model = await modelByCode("wan-qwen-10s");
    const folder = await createFolder(client, "Gagal");

    const created = await client.json<{ generation: GenerationBody }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Uji gagal",
        plannedPrompt: "[SUBJECT] Uji gagal",
        selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
        simulateFailure: true,
      }),
    );
    expect(created.status).toBe(201);
    expect((await balanceOf(account.workspace.id)).tokens).toBe(45);

    const finished = await pollGeneration(client, created.body.generation.id, ["FAILED", "COMPLETED"]);
    expect(finished.status).toBe("FAILED");
    expect(finished.refunded).toBe(true);
    expect(finished.outputUrl).toBeNull();

    const balance = await balanceOf(account.workspace.id);
    expect(balance.tokens).toBe(80);

    const ledger = await db.select().from(tokenLedger).where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(ledger.map((row) => row.txType).sort()).toEqual(["HOLD", "REFUND"]);
  });

  it("rejects a generation the workspace cannot afford", async () => {
    const { client } = await prepare("miskin@example.test", { tokens: 3 });
    const model = await modelByCode("wan-qwen-10s");
    const folder = await createFolder(client, "Saldo");

    const response = await client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Mahal",
        plannedPrompt: "[SUBJECT] Mahal",
        selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Saldo token tidak cukup.");
  });

  it("rejects params outside the model's allowed set", async () => {
    const { client } = await prepare("params@example.test", { tokens: 100 });
    const model = await modelByCode("wan-qwen-10s");
    const folder = await createFolder(client, "Params");

    const badResolution = await client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "x",
        plannedPrompt: "y",
        selectedParams: { durationSec: 10, resolution: "4k", aspectRatio: "16:9" },
      }),
    );
    expect(badResolution.status).toBe(400);
    expect(badResolution.body.error.message).toContain("tidak tersedia untuk model ini");

    const missingDuration = await client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "x",
        plannedPrompt: "y",
        selectedParams: { resolution: "1080p", aspectRatio: "16:9" },
      }),
    );
    expect(missingDuration.status).toBe(400);
    expect(missingDuration.body.error.message).toBe("Durasi wajib dipilih untuk model video.");
  });

  it("validates uploads and accepts an image reference", async () => {
    const { client } = await prepare("upload@example.test", { tokens: 100 });
    const folder = await createFolder(client, "Upload");
    const model = await modelByCode("wan-qwen-5s");

    const text = new FormData();
    text.append("file", new File(["not an image"], "catatan.txt", { type: "text/plain" }));
    const rejectedType = await client.request("/api/creator/uploads", { method: "POST", body: text });
    expect(rejectedType.status).toBe(400);
    expect(await readErrorMessage(rejectedType)).toBe("Format harus JPG, JPEG, PNG, atau WEBP.");

    const big = new FormData();
    big.append("file", new File([new Uint8Array(11 * 1024 * 1024)], "besar.png", { type: "image/png" }));
    const rejectedSize = await client.request("/api/creator/uploads", { method: "POST", body: big });
    expect(rejectedSize.status).toBe(400);
    expect(await readErrorMessage(rejectedSize)).toBe("Ukuran gambar maksimal 10 MB.");

    const png = new FormData();
    png.append("file", new File([new Uint8Array(64)], "kecil.png", { type: "image/png" }));
    const uploaded = await client.json<{ url: string; mime: string; size: number }>(
      "/api/creator/uploads",
      { method: "POST", body: png },
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.mime).toBe("image/png");
    expect(uploaded.body.url).toContain("/media/uploads/");

    const unknownReference = await client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "x",
        plannedPrompt: "y",
        referenceImageUrl: "http://localhost:8787/media/uploads/nobody/unknown.png",
        selectedParams: { durationSec: 5, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );
    expect(unknownReference.status).toBe(400);
    expect(unknownReference.body.error.message).toBe("Gambar referensi tidak dikenal.");

    const withReference = await client.json<{ generation: GenerationBody }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "x",
        plannedPrompt: "y",
        referenceImageUrl: uploaded.body.url,
        selectedParams: { durationSec: 5, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );
    expect(withReference.status).toBe(201);
    await pollGeneration(client, withReference.body.generation.id, ["COMPLETED", "FAILED"]);
  });

  it("deletes a generation inside the active workspace only", async () => {
    const { client } = await prepare("delete@example.test", { tokens: 100 });
    const folder = await createFolder(client, "Hapus");
    const model = await modelByCode("flux-image");

    const created = await client.json<{ generation: GenerationBody }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "x",
        plannedPrompt: "y",
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );

    const deleted = await client.request(`/api/creator/generations/${created.body.generation.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const missing = await client.json<{ error: { code: string } }>(
      `/api/creator/generations/${created.body.generation.id}`,
    );
    expect(missing.status).toBe(404);
  });
});
