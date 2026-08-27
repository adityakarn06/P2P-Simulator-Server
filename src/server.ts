// Side-effect import, kept first and deliberately separate: dotenv must load
// and the schema must validate before any module that reads process.env at
// import time (src/storage/cloudinary.storage.ts, src/config/redis.ts) is
// evaluated. Do not rely on import ordering to arrange this by accident.
import "./config/env.js";

import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`API server listening on port ${env.PORT} (${env.NODE_ENV})`);
});
