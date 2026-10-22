import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import { createApiApp, createDeviceApp } from "./app";
import { PrismaIntegrationStore } from "./integrations/ingest/prismaStore";
import { startDeviceMonitor } from "./jobs/deviceMonitor";

async function main() {
  const cfg = env();
  const db = prisma();
  await db.$connect();
  const store = new PrismaIntegrationStore(db);

  const api = createApiApp(db, cfg).listen(cfg.PORT, () => logger.info(`Admin API listening on :${cfg.PORT}`));
  const dev = createDeviceApp(store, cfg.TRUST_PROXY_HOPS).listen(cfg.DEVICE_PORT, () => logger.info(`Device push endpoint listening on :${cfg.DEVICE_PORT}`));
  const stopMonitor = startDeviceMonitor(db, store, cfg.DEVICE_ONLINE_THRESHOLD_SEC, cfg.DEVICE_MONITOR_INTERVAL_SEC);

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    stopMonitor();
    api.close();
    dev.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
