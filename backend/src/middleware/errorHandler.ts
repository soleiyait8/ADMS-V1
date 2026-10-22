import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[] | undefined)?.join(", ");
      return res.status(409).json({ error: { code: "CONFLICT", message: `A record with this ${target ?? "value"} already exists` } });
    }
    if (err.code === "P2025") return res.status(404).json({ error: { code: "NOT_FOUND", message: "Record not found" } });
  }
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "An unexpected error occurred" } });
}

/** Admin API CSRF defence for cookie-authenticated endpoints (refresh/logout). */
export function requireXhrHeader(req: Request, res: Response, next: NextFunction) {
  if (req.get("X-Requested-With") !== "XMLHttpRequest") {
    return res.status(403).json({ error: { code: "CSRF", message: "Missing X-Requested-With header" } });
  }
  next();
}
