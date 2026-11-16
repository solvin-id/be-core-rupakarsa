import { logger } from "../logger.js";
import { purgeExpiredMedia } from "../services/storage-service.js";

export async function sweepMedia(): Promise<{ purged: number }> {
  const result = await purgeExpiredMedia(200);
  if (result.purged > 0) logger.info({ purged: result.purged }, "media sweep purged expired assets");
  return result;
}
