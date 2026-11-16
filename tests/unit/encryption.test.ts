import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, maskSecret } from "../../src/crypto/encryption.js";

describe("provider secret encryption", () => {
  it("round-trips a secret with the v1 envelope", () => {
    const encrypted = encryptSecret("sk-live-abc123");

    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted.split(":")).toHaveLength(4);
    expect(decryptSecret(encrypted)).toBe("sk-live-abc123");
  });

  it("uses a fresh IV per encryption", () => {
    const first = encryptSecret("sk-live-abc123");
    const second = encryptSecret("sk-live-abc123");
    expect(first).not.toBe(second);
  });

  it("throws when the authentication tag is tampered with", () => {
    const parts = encryptSecret("sk-live-abc123").split(":");
    const tag = Buffer.from(parts[2] ?? "", "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString("base64");

    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("masks all but the first three and last four characters", () => {
    expect(maskSecret("sk-live-abc123")).toBe("sk-••••••••c123");
    expect(maskSecret("short")).toBe("••••••••");
  });
});
