# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# postinstall runs `prisma generate`, which writes src/generated/prisma
# (gitignored, so it must be generated inside the image).
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec prisma generate && pnpm run build

FROM node:24-alpine AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/package.json ./
# `prisma db seed` runs prisma/seed.ts through tsx, and that file imports from
# src/ — so the sources (including the generated Prisma client) ship too.
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=4000
# Puts `prisma` and `tsx` on PATH for migrate/seed commands.
ENV PATH=/app/node_modules/.bin:$PATH
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER nodejs

ENTRYPOINT ["dumb-init", "--"]
# The API process. The worker container runs the same image and overrides this
# with `node dist/workers/index.js` (tsconfig.build.json sets rootDir to ./src,
# so the compiled tree is flat under dist/ — not dist/src/).
CMD ["node", "dist/server.js"]
