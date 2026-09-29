# Production image: one container serves the API under /api and the built SPA from the
# same origin (Knative Service, PORT=8080). Dev keeps using apps/*/Dockerfile.dev.

FROM node:22-slim AS build

# bcrypt/sharp native build toolchain + OpenSSL for Prisma's query engine
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm workspaces: npm ci needs the root lockfile + every workspace's package.json.
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN npm ci --no-audit --no-fund

COPY apps/backend ./apps/backend
COPY apps/frontend ./apps/frontend

# `prisma generate` never connects, but prisma.config.ts requires DATABASE_URL to be set.
# The sed step is the same Linux ".ts" import fix as apps/backend/Dockerfile.dev
# (Prisma 6.19.3 emits ".ts" relative imports on Linux, which fail at runtime).
RUN cd apps/backend \
  && DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
  && find generated/prisma -type f -name '*.ts' ! -name '*.d.ts' -print0 \
     | xargs -0 sed -i -E "s/(from [\"'])([^\"']+)\.ts([\"'])/\1\2.js\3/g"

RUN npm run build:backend && npm run build:frontend


# Backend runtime deps only (the frontend ships as static files), plus the Prisma CLI at
# the locked version for the migration Job. Same base as `build`, so bcrypt/sharp native
# builds match the runtime.
FROM node:22-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN PRISMA_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")" \
  && npm ci --omit=dev --workspace apps/backend --no-audit --no-fund \
  && npm install --no-save --omit=dev --workspace apps/backend --no-audit --no-fund "prisma@${PRISMA_VERSION}"


FROM node:22-slim AS runtime

# npm/npx are not needed at runtime (the migration Job calls node_modules/.bin/prisma) and
# carry their own vulnerable dependency tree, so they are removed from the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production \
    PORT=8080 \
    SPA_DIR=/app/apps/frontend/dist

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/prisma.config.ts ./apps/backend/prisma.config.ts
COPY --from=build /app/apps/backend/prisma ./apps/backend/prisma
COPY --from=build /app/apps/backend/generated ./apps/backend/generated
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist

# LocalDiskStorage writes under cwd/uploads (ephemeral on Knative: lost on scale-to-zero).
RUN mkdir -p /app/apps/backend/uploads && chown node:node /app/apps/backend/uploads

USER node
WORKDIR /app/apps/backend
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
