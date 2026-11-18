import { describe, expect, it } from "vitest";

import { totalSizeFrom } from "../../src/storage/s3-driver.js";

describe("S3 ranged read size", () => {
  it("reads the full object length from Content-Range, never the slice length", () => {
    expect(totalSizeFrom("bytes 0-1023/5000000", 1024, 1024)).toBe(5_000_000);
  });

  it("falls back to Content-Length when the header is absent", () => {
    expect(totalSizeFrom(undefined, 4096, 512)).toBe(4096);
  });

  it("falls back to the buffer length when neither header is present", () => {
    expect(totalSizeFrom(undefined, undefined, 512)).toBe(512);
  });
});
