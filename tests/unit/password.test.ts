import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/auth/password.js";

describe("password hashing", () => {
  it("emits a scrypt descriptor with parameters and 64-byte key", async () => {
    const hash = await hashPassword("rahasia-123");
    const parts = hash.split("$");

    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16384");
    expect(parts[2]).toBe("8");
    expect(parts[3]).toBe("1");
    expect(Buffer.from(parts[4] ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5] ?? "", "base64")).toHaveLength(64);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("rahasia-123");

    await expect(verifyPassword("rahasia-123", hash)).resolves.toBe(true);
    await expect(verifyPassword("rahasia-124", hash)).resolves.toBe(false);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    await expect(verifyPassword("x", "plaintext")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$1$2$3$$")).resolves.toBe(false);
  });

  it("salts every hash", async () => {
    const first = await hashPassword("same");
    const second = await hashPassword("same");
    expect(first).not.toBe(second);
  });
});
