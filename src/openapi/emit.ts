import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "./spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../openapi.json");

await writeFile(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${target}\n`);
process.exit(0);
