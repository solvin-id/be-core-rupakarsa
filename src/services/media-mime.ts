import { fileTypeFromBuffer } from "file-type";

const DEFAULT_MIME: Record<"VIDEO" | "IMAGE", string> = {
  VIDEO: "video/mp4",
  IMAGE: "image/png",
};

const GENERIC_MIMES: Record<string, true> = {
  "application/octet-stream": true,
  "binary/octet-stream": true,
  "": true,
};

/**
 * The simulation renderer produces a poster, not encoded media, for both media types. It is the
 * one legitimate cross-family type: it must stay an image so the studio can actually show it.
 */
const POSTER_MIME = "image/svg+xml";

function belongsTo(mime: string, mediaType: "VIDEO" | "IMAGE"): boolean {
  return mediaType === "VIDEO" ? mime.startsWith("video/") : mime.startsWith("image/");
}

/**
 * Provider output MIME is untrusted: gateways commonly answer `application/octet-stream`, which
 * would store a `.bin` key and make `<video>` and the media route disagree about the asset. The
 * declared type wins only when it is a real family match; otherwise the bytes decide, and the
 * media-type default is the last resort so a render never fails on metadata.
 */
export async function resolveOutputMime(
  bytes: Buffer,
  declared: string,
  mediaType: "VIDEO" | "IMAGE",
): Promise<string> {
  const claim = (declared.split(";")[0] ?? "").trim().toLowerCase();
  if (claim === POSTER_MIME) return claim;
  if (!GENERIC_MIMES[claim] && belongsTo(claim, mediaType)) return claim;

  try {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected?.mime === POSTER_MIME) return POSTER_MIME;
    if (detected && belongsTo(detected.mime, mediaType)) return detected.mime;
  } catch {
    // A truncated or tiny body is not classifiable; fall through to the media-type default.
  }

  return DEFAULT_MIME[mediaType];
}
