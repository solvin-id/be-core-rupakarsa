import { createApp } from "../app.js";

export const OPENAPI_INFO = {
  openapi: "3.0.0" as const,
  info: { title: "Rupakarsa API", version: "1.0.0" },
  servers: [{ url: "http://localhost:8787", description: "Local development" }],
};

/** Single source of truth for the committed contract and its drift-guard test. */
export function buildOpenApiDocument() {
  const app = createApp();
  return app.getOpenAPIDocument(OPENAPI_INFO);
}
