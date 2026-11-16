import pino from "pino";

import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: [
    "req.headers.cookie",
    "req.headers.authorization",
    "res.headers['set-cookie']",
    "headers.cookie",
    "headers.authorization",
  ],
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});
