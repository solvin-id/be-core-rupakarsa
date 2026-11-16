import { randomUUID } from "node:crypto";

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { fileTypeFromBuffer } from "file-type";

import { sessionGuard } from "../../auth/middleware.js";
import { validation } from "../../http/errors.js";
import { uploadBodyLimit } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { ErrorResponseSchema, UploadResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { putAsset } from "../../services/storage-service.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function normalizeMime(mime: string): string {
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function slugifyName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "berkas";
}

export const creatorUploadRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

creatorUploadRoutes.use("/uploads", sessionGuard(), uploadBodyLimit);

const uploadRoute = createRoute({
  method: "post",
  path: "/uploads",
  tags: ["Creator uploads"],
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: { file: { type: "string", format: "binary" } },
            required: ["file"],
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Stored media asset",
      content: { "application/json": { schema: UploadResponseSchema } },
    },
    400: { description: "Unsupported file", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

creatorUploadRoutes.openapi(uploadRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth.workspaceId) throw validation("Pilih workspace aktif sebelum mengunggah berkas.");

  const body = await c.req.parseBody();
  const file = body["file"];

  if (!(file instanceof File)) throw validation("Berkas wajib diunggah.");

  const claimedMime = normalizeMime(file.type);
  const extension = MIME_EXTENSIONS[claimedMime];
  if (!extension) throw validation("Format harus JPG, JPEG, PNG, WEBP, MP4, atau WEBM.");

  const isVideo = claimedMime.startsWith("video/");
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const limitMessage = isVideo ? "Ukuran video maksimal 100 MB." : "Ukuran gambar maksimal 10 MB.";
  if (file.size > maxBytes) throw validation(limitMessage);

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw validation(limitMessage);

  const detected = await fileTypeFromBuffer(bytes);
  const detectedMime = detected ? normalizeMime(detected.mime) : "";
  if (!MIME_EXTENSIONS[detectedMime] || detectedMime !== claimedMime) {
    throw validation("Isi berkas tidak cocok dengan tipe yang diklaim.");
  }

  const key = `workspaces/${auth.workspaceId}/uploads/${auth.user.id}/${randomUUID()}-${slugifyName(file.name)}.${extension}`;
  const { asset, url } = await putAsset(auth.workspaceId, key, bytes, claimedMime, {
    uploadedBy: auth.user.id,
    durationMs: null,
  });

  return c.json(
    { id: asset.id, url, key, mime: claimedMime, size: bytes.byteLength, durationMs: null },
    201,
  );
});
