import { once } from "node:events";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { generations } from "../../src/db/schema.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";

let server: ReturnType<typeof serve> | null = null;
let base = "";

beforeAll(async () => {
  const app = createApp();
  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("app server did not bind");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

interface StreamEvent {
  event: string;
  data: string;
}

/**
 * Reads the SSE body incrementally until `done` or the deadline. Real time is unavoidable: the
 * stream pushes on its own 2 s poll, which fake timers cannot advance inside the server. One read
 * promise is reused across timeout rounds, so a chunk is never swallowed by an abandoned read.
 */
async function readEvents(
  response: Response,
  done: (events: StreamEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  let pending = reader.read();

  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      pending,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);
    if (outcome === "timeout") continue;

    pending = reader.read();
    if (outcome.done) break;
    buffer += decoder.decode(outcome.value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (event) events.push({ event, data });
      boundary = buffer.indexOf("\n\n");
    }
    if (done(events)) break;
  }

  await reader.cancel();
  return events;
}

describe("generation stream", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("requires a session", async () => {
    const response = await fetch(`${base}/api/creator/generations/stream`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("pushes the active snapshot and the finished row for the same generation", async () => {
    const account = await createAccount({ email: "stream@example.test" });
    await db.execute(`update workspaces set token_balance = 100 where id = '${account.workspace.id}'`);

    const client = createClient();
    await login(client, "stream@example.test");
    const folder = await createFolder(client, "Stream");
    const model = await modelByCode("flux-image");

    // A row that never renders keeps the active snapshot non-empty, so the delta is observable.
    const queuedId = crypto.randomUUID();
    await db.insert(generations).values({
      id: queuedId,
      workspaceId: account.workspace.id,
      folderId: folder.id,
      userId: account.user.id,
      modelId: model.id,
      modelName: model.displayName,
      mediaType: "IMAGE",
      rawPrompt: "Antre",
      selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      status: "QUEUED",
    });

    const streamResponse = await fetch(`${base}/api/creator/generations/stream`, {
      headers: { cookie: client.cookie() },
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type") ?? "").toContain("text/event-stream");

    const collected = readEvents(
      streamResponse,
      (events) => events.some((event) => event.event === "finished"),
      20_000,
    );

    // Let the first snapshot arrive before the render row exists, so the test proves the delta too.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const created = await client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Uji stream",
        planMode: false,
        finalPrompt: null,
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );
    expect(created.status).toBe(201);
    const generationId = created.body.generation.id;

    const events = await collected;
    const first = events.findIndex((event) => event.event === "generations");
    const finished = events.findIndex(
      (event) => event.event === "finished" && event.data.includes(generationId),
    );

    expect(first).toBeGreaterThanOrEqual(0);
    expect(events[first]?.data).toContain(queuedId);
    expect(finished).toBeGreaterThan(first);

    const finishedRow = JSON.parse(events[finished]?.data ?? "{}") as {
      id: string;
      status: string;
      startedAt: string | null;
    };
    expect(finishedRow.id).toBe(generationId);
    expect(finishedRow.status).toBe("COMPLETED");
    expect(finishedRow.startedAt).not.toBeNull();
  });
});
