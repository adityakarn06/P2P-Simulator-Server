import { Router } from "express";
import { attachTenant, requireOrganization } from "../middleware/auth.js";
import { apiRateLimit } from "../middleware/rateLimit.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { analyticsRouter } from "./analytics.routes.js";
import { auditLogRouter } from "./auditLog.routes.js";
import { exceptionRouter } from "./exception.routes.js";
import { healthRouter } from "./health.routes.js";
import { invoiceRouter } from "./invoice.routes.js";
import { paymentRouter } from "./payment.routes.js";
import { purchaseOrderRouter } from "./purchaseOrder.routes.js";
import { receiptRouter } from "./receipt.routes.js";
import { requisitionRouter } from "./requisition.routes.js";
import { shipmentRouter } from "./shipment.routes.js";
import { productRouter, supplierRouter } from "./supplier.routes.js";

export const rootRouter: Router = Router();

rootRouter.use(healthRouter);

export const apiV1Router: Router = Router();
apiV1Router.use(apiRateLimit);
apiV1Router.use(attachTenant);
apiV1Router.use(asyncHandler(requireOrganization));

apiV1Router.use("/requisitions", requisitionRouter);
apiV1Router.use("/suppliers", supplierRouter);
apiV1Router.use("/products", productRouter);
apiV1Router.use("/purchase-orders", purchaseOrderRouter);
apiV1Router.use("/shipments", shipmentRouter);
apiV1Router.use("/receipts", receiptRouter);
apiV1Router.use("/invoices", invoiceRouter);
apiV1Router.use("/payments", paymentRouter);
apiV1Router.use("/exceptions", exceptionRouter);
apiV1Router.use("/audit-logs", auditLogRouter);
apiV1Router.use("/analytics", analyticsRouter);

rootRouter.use("/api/v1", apiV1Router);
