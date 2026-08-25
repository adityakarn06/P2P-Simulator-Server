import { Router } from "express";
import { getShipmentById, getShipments } from "../controllers/shipment.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const shipmentRouter: Router = Router();

shipmentRouter.get("/", asyncHandler(getShipments));
shipmentRouter.get("/:id", asyncHandler(getShipmentById));
