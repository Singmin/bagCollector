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
# 只构建服务端产物。根 `build` 脚本还会构建小程序，但服务器镜像里用不到它，
# 每个矩阵 target 都白跑一遍、还要求 VITE_API_BASE_URL —— 那是 upload-miniapp
# 工作流（miniapp-uploader target）自己负责的事。
RUN pnpm db:generate && pnpm build:server

# ---------------------------------------------------------------------------
# 生产依赖裁剪。
# 历史上 api/worker 直接 COPY build stage 的整个 /app/node_modules —— 那是
# 全 monorepo 的全量安装（含 devDependencies）：小程序的 dcloudio/vite、admin 的
# react、@nestjs/cli、miniprogram-ci、typescript、vitest、eslint 全在里面，
# 压出一个 203.5MB 的层，大陆服务器拉 GHCR 时几乎必然超时。
# 这里重新做一次「只装 api+worker 生产依赖」的过滤安装（--prod + --filter），
# 该 node_modules 层由下面的运行时镜像独占（api / worker / migrate 三个容器共用），
# 预计从 203.5MB 降到几十 MB 级。
# 注意 prisma CLI 是 api 的生产依赖（compose 的 migrate 服务要在 api 镜像里
# 跑 `pnpm --filter @bagcollect/api db:deploy`），不要把它挪回 devDependencies。
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --prod \
      --filter @bagcollect/api... --filter @bagcollect/worker...
# Prisma client 必须在「这次安装」里重新生成，不能从 build stage 复制：
# 生成的 .prisma/client 落在 .pnpm 虚拟存储的 @prisma+client 实例目录里，
# 目录名带 peer 依赖哈希，build（全量安装）与 prod-deps（过滤安装）的
# peer 集合不同 → 实例目录名不同 → 复制过去运行时也解析不到。
COPY apps/api/prisma apps/api/prisma
RUN pnpm --filter @bagcollect/api exec prisma generate --schema prisma/schema.prisma

# ---------------------------------------------------------------------------
# 运行时镜像：一个 target 承载 api 与 worker 两个角色，由 compose 的 command 区分。
#
# 为什么合并（而不是 api / worker 各做一个）：prod-deps 是一次 install，两个角色
# COPY 的是同一个 /app/node_modules，因此两个镜像的层几乎逐字节相同 —— 旧版实测
# 最大层同为 203.5MB，差别只有各自的 dist（api 约 340KB）。
# 拆成两个镜像的唯一正当理由是「依赖集合不同」，而联合过滤安装
# （--filter api... --filter worker...）已经把这个差别抹掉了：装进
# /app/node_modules/.pnpm 的是两边的**并集** —— 也就是说 api 镜像里实际躺着 sharp
# 的文件、worker 镜像里躺着 @nestjs/* 的文件，只是项目级 node_modules 没有为对方
# 建符号链接，所以各自 import 不到（体积照占）。既然在体积上两个角色早已不可区分，
# 继续拆开、多维护一个镜像 + 一个 CI matrix target + 一个镜像仓库条目就是纯开销。
# 合并的代价：两个角色必须同版本同发布（当前每次都一起部署，符合）；
# 镜像体积只多出几百 KB 的 dist，拉取量不变（层本来就共享）。
# 回退方案：将来若 worker 需要独立发布或独立伸缩，把 worker 的 COPY 段拆回
# 一个独立 target 即可，prod-deps 已经为两个角色都装好了依赖。
# ---------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/contracts ./packages/contracts
# prisma schema 两个角色共用（worker 侧的 @prisma/client 也依赖它存在）。
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
# 只取运行时需要的产物。整个 apps/api 不能从 build 复制 —— 里面的
# node_modules 符号链接指向全量安装的 .pnpm 实例，会覆盖掉 prod-deps 那份。
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
# worker 角色的产物，与上面共用同一份 node_modules 与 prisma schema。
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
EXPOSE 3001
# 默认角色是 api，方便 `docker run` 手工调试；compose 里两个服务都显式写 command，
# 不依赖这里的默认值。
CMD ["node", "apps/api/dist/main.js"]

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
