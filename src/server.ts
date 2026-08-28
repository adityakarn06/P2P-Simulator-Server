// Side-effect import, kept first and deliberately separate: dotenv must load
// and the schema must validate before any module that reads process.env at
// import time (src/storage/cloudinary.storage.ts, src/config/redis.ts) is
// evaluated. Do not rely on import ordering to arrange this by accident.
import "./config/env.js";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { disconnectPrisma } from "./config/prisma.js";
import { redis } from "./config/redis.js";
import { closeQueues } from "./queues/index.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`API server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Without this, every redeploy or tsx-watch restart strands this process's
// Redis clients until the server times them out — enough restarts against a
// connection-capped Redis and the next boot gets "ERR max number of clients
// reached".
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down API process...`);
  // Docker sends SIGKILL ~10s after SIGTERM; never let a hung dependency eat
  // that window and skip the connection cleanup below.
  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out, exiting.");
    process.exit(1);
  }, 8000);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Keep-alive sockets would otherwise hold server.close() open.
      server.closeIdleConnections();
    });
    await closeQueues();
    await redis.quit();
    await disconnectPrisma();
    console.log("API process shut down cleanly.");
    process.exit(0);
  } catch (error) {
    console.error("Error during API shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
