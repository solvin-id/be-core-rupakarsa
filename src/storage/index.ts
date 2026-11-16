import { env } from "../env.js";
import type { StorageDriver } from "../adapters/types.js";
import { createLocalStorage } from "./local-driver.js";
import { createR2Storage } from "./r2-driver.js";

let cached: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (!cached) {
    cached = env.STORAGE_DRIVER === "r2" ? createR2Storage() : createLocalStorage();
  }
  return cached;
}

export type { StorageDriver };
