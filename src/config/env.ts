import "dotenv/config";
import { z } from "zod";

export const envSchema = z.object({
  // An enum, not a free string: the production branch in
  // src/middleware/errorHandler.ts is the only thing suppressing internal error
  // messages, and a typo like "producton" would silently disable it. The set is
  // wide enough for the usual deployment names so a real environment cannot be
  // locked out by this check — only a misspelling fails, and it fails at boot.
  NODE_ENV: z.enum(["development", "test", "ci", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.url(),
  DIRECT_DATABASE_URL: z.url(),

  REDIS_URL: z.url().default("redis://localhost:6379"),

  GEMINI_API_KEY: z.string().min(1),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // Required, not optional. An undefined origin makes the cors package fall
  // back to "*", and "*" paired with credentials: true (src/app.ts) is the
  // classic permissive-CORS misconfiguration.
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),

  // Number of proxy hops in front of this process, for express-rate-limit's
  // client-IP resolution. Defaults to 0 (trust nobody): when the process is
  // reachable directly, trusting a hop that is not there lets any client forge
  // X-Forwarded-For and hand itself an unlimited quota. Set to 1 behind a
  // single load balancer or ingress.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  DEV_ORGANIZATION_ID: z.string().default("dev-org"),
  DEV_USER_ID: z.string().default("dev-user"),
});

declare global {
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof envSchema> {}
  }
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const invalidKeys = Object.keys(z.flattenError(parsed.error).fieldErrors);
  console.error(
    `Invalid environment variables: ${invalidKeys.join(", ")}. Check your .env file against .env.example.`,
  );
  process.exit(1);
}

/**
 * The validated, coerced config. Prefer this over reading `process.env`
 * directly: `process.env.PORT` is a string at runtime however the schema types
 * it, and defaults declared above only exist here.
 */
export const env = parsed.data;
