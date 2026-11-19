import { describe, expect, it } from "vitest";

import { signMediaUrl, verifyMediaSignature } from "../../src/services/storage-service.js";

const KEY = "workspaces/w/generations/g1.mp4";
const TTL = 86400;

function parseSigned(url: string): { key: string; exp: number; sig: string } {
  const parsed = new URL(url);
  return {
    key: parsed.pathname.replace(/^\/media\//, ""),
    exp: Number(parsed.searchParams.get("exp")),
    sig: parsed.searchParams.get("sig") ?? "",
  };
}

describe("signed media URLs", () => {
  it("returns the identical URL for the same key inside one bucket", () => {
    expect(signMediaUrl(KEY, TTL)).toBe(signMediaUrl(KEY, TTL));
  });

  it("expires at or after the requested TTL and inside the next bucket", () => {
    const before = Math.floor(Date.now() / 1000);
    const { exp } = parseSigned(signMediaUrl(KEY, TTL));
    const after = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThanOrEqual(before + TTL);
    expect(exp).toBeLessThan(after + TTL + 3600);
  });

  it("signs each key separately and rejects a tampered signature", () => {
    const first = parseSigned(signMediaUrl(KEY, TTL));
    const second = parseSigned(signMediaUrl("workspaces/w/generations/g2.mp4", TTL));
    expect(first.sig).not.toBe(second.sig);
    expect(verifyMediaSignature(first.key, first.exp, first.sig)).toBe(true);

    const flipped = (first.sig[0] === "A" ? "B" : "A") + first.sig.slice(1);
    expect(verifyMediaSignature(first.key, first.exp, flipped)).toBe(false);
  });
});
