import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/AppError.js";
import { sendError } from "../utils/response.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(err);

  if (err instanceof AppError) {
    sendError(res, err.code, err.message, err.statusCode, err.details);
    return;
  }

  if (err instanceof z.ZodError) {
    sendError(res, "VALIDATION_ERROR", "Invalid request", 400, z.flattenError(err));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // `target` names the offending column/index. Useful locally, internal
      // schema detail in production.
      sendError(
        res,
        "CONFLICT",
        "A record with these values already exists",
        409,
        env.NODE_ENV === "production" ? undefined : { target: err.meta?.target },
      );
      return;
    }
    if (err.code === "P2025") {
      sendError(res, "NOT_FOUND", "Resource not found", 404);
      return;
    }
  }

  const message =
    env.NODE_ENV === "production"
      ? "An unexpected error occurred"
      : err instanceof Error
        ? err.message
        : "An unexpected error occurred";

  sendError(res, "INTERNAL_ERROR", message, 500);
}
