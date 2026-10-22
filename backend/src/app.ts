import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "./config/env";
import { authenticate } from "./middleware/authenticate";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/routes";
import { usersRouter } from "./modules/users/routes";
import { employeesRouter } from "./modules/employees/routes";
import { devicesRouter } from "./modules/devices/routes";
import { attendanceRouter } from "./modules/attendance/routes";
import { dashboardRouter } from "./modules/dashboard/routes";
import { syncRouter } from "./modules/sync/routes";
import { auditRouter } from "./modules/audit/routes";
import { adapterRegistry } from "./integrations/adapters";
import { zkPushRouter } from "./integrations/zkteco-push/router";
import type { IntegrationStore } from "./integrations/types";

/** Admin/HR API – served behind Nginx/HTTPS on the public (or intranet) hostname. */
export function createApiApp(db: PrismaClient, cfg: Env) {
  const app = express();
  app.set("trust proxy", cfg.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: cfg.CORS_ORIGIN.split(","), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api/", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get("/api/health", async (_req, res) => {
    try { await db.$queryRaw`SELECT 1`; res.json({ status: "ok" }); }
    catch { res.status(503).json({ status: "db_unavailable" }); }
  });

  app.use("/api/v1/auth", authRouter(db, cfg));
  const authed = authenticate(db, cfg.JWT_ACCESS_SECRET);
  app.use("/api/v1/users", authed, usersRouter(db));
  app.use("/api/v1/employees", authed, employeesRouter(db));
  app.use("/api/v1/devices", authed, devicesRouter(db, cfg, adapterRegistry(db, cfg.DEVICE_ONLINE_THRESHOLD_SEC)));
  app.use("/api/v1/attendance", authed, attendanceRouter(db));
  app.use("/api/v1/dashboard", authed, dashboardRouter(db, cfg));
  app.use("/api/v1/sync", authed, syncRouter(db));
  app.use("/api/v1/audit-logs", authed, auditRouter(db));

  app.use("/api", (_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }));
  app.use(errorHandler);
  return app;
}

/** Device-facing app on its own port; firewalled to device networks only. */
export function createDeviceApp(store: IntegrationStore, trustProxyHops: number) {
  const app = express();
  app.set("trust proxy", trustProxyHops);
  app.disable("x-powered-by");
  app.use(zkPushRouter(store));
  app.use((_req, res) => res.status(404).type("text/plain").send("Not Found"));
  return app;
}
