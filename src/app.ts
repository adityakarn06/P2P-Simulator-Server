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

  // crossOriginResourcePolicy is relaxed to match the wide-open CORS below:
  // helmet's "same-origin" default makes the browser refuse cross-origin
  // *resource* loads, which would block a frontend embedding or downloading a
  // generated invoice PDF from this API. Everything else keeps helmet's
  // defaults.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // Wide open on purpose: this is a no-auth hackathon MVP with no cookies and
  // no Authorization header (src/middleware/auth.ts attaches a fixed dev
  // tenant), so there is no credentialed request for an origin allowlist to
  // protect. `credentials: true` is deliberately absent — browsers reject it
  // alongside `Access-Control-Allow-Origin: *`.
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "1mb" }));

  app.use(rootRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
