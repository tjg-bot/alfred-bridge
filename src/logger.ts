import pino from "pino";

export const logger = pino({
  level: process.env.BRIDGE_LOG_LEVEL || "info",
});

export type Logger = typeof logger;
