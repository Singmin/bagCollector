FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json eslint.config.mjs vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm db:generate && pnpm build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/api ./apps/api
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/worker ./apps/worker
CMD ["node", "apps/worker/dist/main.js"]

FROM nginx:1.27-alpine AS admin
COPY infra/nginx/admin.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html

# ---------------------------------------------------------------------------
# 自托管 rembg + BiRefNet 推理镜像。已不在主链路上（Worker 不依赖它），
# CI 与部署矩阵也不构建该 target。定义保留未删除，单独做推理实验时可用。
# 现行抠图方案见 docs/TENCENT_CI_MATTING.md。
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS rembg
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    REMBG_HOME=/models
RUN pip install --no-cache-dir 'rembg[cpu,cli]==2.0.84' \
    && mkdir -p "$REMBG_HOME" \
    && python -c "from rembg import new_session; new_session('birefnet-general-lite')"
COPY infra/rembg-entrypoint.sh /usr/local/bin/rembg-entrypoint.sh
RUN chmod +x /usr/local/bin/rembg-entrypoint.sh
# 注意：这里不要设 OMP_NUM_THREADS。它是真正的推理线程数开关，实测限制线程数会让
# 推理变慢（访存带宽瓶颈），留空交给 onnxruntime 自行决定最快。详见 rembg-entrypoint.sh。
ENV REMBG_SERVER_CONCURRENCY=1
EXPOSE 7000
ENTRYPOINT ["/usr/local/bin/rembg-entrypoint.sh"]

FROM deps AS miniapp-uploader
COPY apps/miniapp ./apps/miniapp
COPY scripts/upload-miniapp.mjs ./scripts/upload-miniapp.mjs
CMD ["node", "scripts/upload-miniapp.mjs"]
