FROM node:22.19.0-bookworm-slim AS builder
WORKDIR /workspace
RUN npm install --global pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM builder AS api
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/index.js"]

FROM builder AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/index.js"]

FROM builder AS migrator
CMD ["pnpm", "migrate"]

FROM nginxinc/nginx-unprivileged:1.27.5-alpine AS web
COPY docker/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html

FROM nginxinc/nginx-unprivileged:1.27.5-alpine AS proxy
COPY docker/nginx/proxy.conf /etc/nginx/conf.d/default.conf
