# Trusted web and graph services. Use ONLY with host-managed ROOTLESS Docker.
FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.15.0 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY web/package.json web/tsconfig.json web/vite.config.ts ./web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm --filter @noveltea/studio build

FROM node:24-bookworm-slim
RUN npm install --global pnpm@11.15.0 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
# Running as container root is only supported on the host's rootless daemon:
# uid 0 maps to the unprivileged daemon owner for shared-volume permissions.
# No untrusted shell or file tool runs in these trusted services.
CMD ["pnpm","--filter","@noveltea/studio","start"]
