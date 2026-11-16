import { env } from "../env.js";
import { getStorage } from "../storage/index.js";
import { StubPlanAdapter } from "../adapters/stub-plan.js";
import { StubRenderAdapter } from "../adapters/stub-render.js";
import type { ProviderRegistry } from "../adapters/types.js";

let cached: ProviderRegistry | null = null;

export function getProviders(): ProviderRegistry {
  if (!cached) {
    if (env.PROVIDER_MODE !== "stub") {
      throw new Error(`Unsupported PROVIDER_MODE: ${env.PROVIDER_MODE}`);
    }
    cached = {
      plan: new StubPlanAdapter(),
      render: new StubRenderAdapter(getStorage()),
    };
  }
  return cached;
}
