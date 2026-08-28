import { Router } from "express";
import { getPayment, getPayments } from "../controllers/payment.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Read-only, deliberately. Payments are created by the payment worker and
 * authorized by resolving an exception; an HTTP endpoint that could mark an
 * invoice paid would bypass the three-way match and the settlement caps
 * entirely (CLAUDE.md §Security: "Users must not be able to mark invoices
 * paid"). Do not add mutations here.
 */
export const paymentRouter: Router = Router();

paymentRouter.get("/", asyncHandler(getPayments));
paymentRouter.get("/:id", asyncHandler(getPayment));
