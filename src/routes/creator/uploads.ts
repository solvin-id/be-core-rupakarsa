import { randomUUID } from "node:crypto";

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { mediaAssets } from "../../db/schema.js";
import { validation } from "../../http/errors.js";
import { uploadBodyLimit } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { ErrorResponseSchema, UploadResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { getStorage } from "../../storage/index.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

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
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!(file instanceof File)) throw validation("Berkas gambar wajib diunggah.");

  const extension = MIME_EXTENSIONS[file.type];
  if (!extension) throw validation("Format harus JPG, JPEG, PNG, atau WEBP.");
  if (file.size > MAX_UPLOAD_BYTES) throw validation("Ukuran gambar maksimal 10 MB.");

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw validation("Ukuran gambar maksimal 10 MB.");

  const key = `uploads/${auth.user.id}/${randomUUID()}.${extension}`;
  const storage = getStorage();
  await storage.put(key, bytes, file.type);

  await db.insert(mediaAssets).values({
    key,
    mime: file.type,
    size: bytes.byteLength,
    uploadedBy: auth.user.id,
  });

  return c.json({ url: storage.url(key), mime: file.type, size: bytes.byteLength }, 201);
});
