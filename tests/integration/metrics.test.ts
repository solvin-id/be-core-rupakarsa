import { beforeAll, describe, expect, it } from "vitest";

// Metrics are disabled unless a token is configured, so this file boots with one.
process.env.METRICS_TOKEN = "secret-token";

const helpers = await import("./helpers.js");

describe("metrics endpoint", () => {
  beforeAll(async () => {
    await helpers.resetDatabase();
  });

  it("hides the endpoint without a token and serves Prometheus text with one", async () => {
    const client = helpers.createClient();

    const anonymous = await client.request("/metrics");
    expect(anonymous.status).toBe(404);

    const wrong = await client.request("/metrics", {
      headers: { authorization: "Bearer salah" },
    });
    expect(wrong.status).toBe(404);

    const authorized = await client.request("/metrics", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authorized.status).toBe(200);
    const text = await authorized.text();
    expect(text).toContain("rupakarsa_render_total");
    expect(text).toContain("rupakarsa_queue_waiting");
  });
});
