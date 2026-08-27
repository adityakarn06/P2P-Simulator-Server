import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { rootRouter } from "./routes/index.js";

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, express-rate-limit otherwise keys every request to
  // the proxy's own IP and the whole deployment shares one bucket. Opt in via
  // TRUST_PROXY_HOPS rather than hardcoding it: trusting a hop that is not
  // there is the worse failure, letting any client forge X-Forwarded-For.
  if (env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
  }

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.use(rootRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
