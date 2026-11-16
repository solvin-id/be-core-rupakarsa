import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import { env } from "../env.js";
import { defaultHook } from "../http/route-helpers.js";
import type { AppBindings } from "../http/types.js";
import { getQueueCounts } from "../queue/index.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const renderTotal = new Counter({
  name: "rupakarsa_render_total",
  help: "Render jobs by terminal status and provider",
  labelNames: ["status", "provider"] as const,
  registers: [metricsRegistry],
});

export const renderDuration = new Histogram({
  name: "rupakarsa_render_duration_seconds",
  help: "Render duration in seconds",
  labelNames: ["provider"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export const queueWaiting = new Gauge({
  name: "rupakarsa_queue_waiting",
  help: "Jobs waiting in the render queue",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

export const tokensCharged = new Counter({
  name: "rupakarsa_tokens_charged_total",
  help: "Tokens charged to workspaces",
  labelNames: ["provider"] as const,
  registers: [metricsRegistry],
});

function requireMetricsToken(): MiddlewareHandler<AppBindings> {
  return async (c: Context<AppBindings>, next) => {
    if (env.METRICS_TOKEN.length === 0) return c.notFound();
    const header = c.req.header("authorization") ?? "";
    if (header !== `Bearer ${env.METRICS_TOKEN}`) return c.notFound();
    await next();
  };
}

export const metricsRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

metricsRoutes.use("/metrics", requireMetricsToken());

metricsRoutes.get("/metrics", async (c) => {
  try {
    const counts = await getQueueCounts();
    queueWaiting.set({ queue: "generation" }, counts.waiting);
  } catch {
    // Prometheus can still scrape the in-process counters when Redis is down.
  }

  const body = await metricsRegistry.metrics();
  return c.body(body, 200, { "Content-Type": metricsRegistry.contentType });
});
