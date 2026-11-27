# syntax=docker/dockerfile:1
#
# The web app as a container: Next.js's standalone server, for the AWS stack's
# opt-in `web` profile (docs/AWS_BRING_UP.md). Vercel and Cloudflare deploys do
# not use it.
#
# Build from the repository root so the shared package is in the context:
#   docker build -f packages/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://control-plane.example.com \
#     -t open-inspect-web .
#
# Next.js inlines NEXT_PUBLIC_* into the client bundle at build time, so each
# deployment builds its own image with its own values.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
# --ignore-scripts: the root package's prepare script installs git hooks
# through husky, which a workspace-scoped install does not bring along.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/web
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_APP_ICON_URL
ARG NEXT_PUBLIC_SANDBOX_PROVIDER
ARG NEXT_PUBLIC_SCM_PROVIDER
RUN test -n "$NEXT_PUBLIC_WS_URL" || { echo "NEXT_PUBLIC_WS_URL build arg is required" >&2; exit 1; }
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @open-inspect/shared \
    && npm run build -w @open-inspect/web

FROM node:24-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The standalone output mirrors the monorepo layout because the tracing root is
# the repository root (packages/web/next.config.ts). It does not copy the
# static assets or public/, which the server still serves.
COPY --from=build --chown=node:node /app/packages/web/.next/standalone ./
COPY --from=build --chown=node:node /app/packages/web/.next/static packages/web/.next/static
COPY --from=build --chown=node:node /app/packages/web/public packages/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/favicon.ico`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/web/server.js"]
