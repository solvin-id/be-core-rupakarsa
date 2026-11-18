import { describe, expect, it } from "vitest";

import { resolveOutputMime } from "../../src/services/media-mime.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** MP4 `ftyp` box header, enough for file-type to classify the bytes. */
const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

describe("output mime resolution", () => {
  it("falls back to video/mp4 for unclassifiable bytes declared as octet-stream", async () => {
    expect(await resolveOutputMime(Buffer.from([0xff, 0x00, 0x01]), "application/octet-stream", "VIDEO"))
      .toBe("video/mp4");
  });

  it("detects a real image when the provider sends no content type", async () => {
    expect(await resolveOutputMime(PNG_BYTES, "", "IMAGE")).toBe("image/png");
  });

  it("keeps a declared mime that matches the media family", async () => {
    expect(await resolveOutputMime(PNG_BYTES, "image/webp", "IMAGE")).toBe("image/webp");
    expect(await resolveOutputMime(MP4_HEADER, "video/mp4; codecs=avc1", "VIDEO")).toBe("video/mp4");
  });

  it("trusts a declared mime only inside its own family", async () => {
    // The declaration says video and the row is a video: accept it without re-reading the bytes.
    expect(await resolveOutputMime(PNG_BYTES, "video/mp4", "VIDEO")).toBe("video/mp4");
    // The same declaration on an image row is not a family match; the bytes win.
    expect(await resolveOutputMime(PNG_BYTES, "video/mp4", "IMAGE")).toBe("image/png");
  });
});
