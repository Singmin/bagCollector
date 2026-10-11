# BagCollect 部署到宝塔服务器（GitHub Actions 自动化）

面向宝塔面板（aaPanel）+ Docker 的部署手册。CI/CD 由 GitHub Actions 驱动，仓库里已经配好，本文只讲怎么把它接到你的服务器上。

抠图走腾讯云数据万象，是云端按次计费接口，**服务器上不需要任何推理服务**。应用运行时 2 核 2G 可以承载；服务器仍需编译 API/Worker，建议 4G 内存，2G 机器至少配置 swap 并顺序构建。Admin 已改为在 GitHub Runner 编译，服务器只打包静态产物。

相关文档：
- 环境变量与腾讯云凭据：[腾讯云数据万象抠图实施方案](TENCENT_CI_MATTING.md)、[腾讯云凭据获取教程](TENCENT_CLOUD_SETUP.md)
- 小程序侧配置（AppID、合法域名、上传私钥）：[uni-app 微信小程序运行与发布](WECHAT_NATIVE.md)

---

## 1. 最终形态

```text
GitHub 仓库 (main)
   │  push / 手动触发
   ▼
GitHub Actions
  ├─ verify   复用 ci.yml：lint → typecheck → 单测 → 迁移 → 构建 → 保存 Admin 产物
   └─ deploy   git archive 固定 commit + 同 SHA 的 Admin 产物 → SCP → SSH 到服务器
                  └─ sh infra/build-and-deploy.sh
                        编译 api/worker + 打包 Admin 静态资源（SHA 标签）
                        → 备份库 → 起 postgres/redis → 跑迁移
                        → 切 api/worker/admin → 等健康检查 → 失败则回滚

宝塔服务器 /www/wwwroot/bagcollect
   └─ docker compose 项目
        ├─ postgres   仅 127.0.0.1:5432   ← 宝塔 Docker 管理器可见，宿主机可连
        ├─ redis      仅 127.0.0.1:6379
        ├─ api        仅 127.0.0.1:3001   ← 宝塔 Nginx 反代到这里
        ├─ worker     无对外端口
        └─ admin      仅 127.0.0.1:8081   ← 宝塔 Nginx 反代到这里

公网
   api.example.com   → 宝塔 Nginx (443) → 127.0.0.1:3001
   admin.example.com → 宝塔 Nginx (443) → 127.0.0.1:8081，/api 走 3001
```

**关于「数据库也是容器」**：`postgres` 与 `redis` 由同一个 compose 文件统一下发，跑在你宝塔那台机器的 Docker 里。它们和 api/worker/admin 是同一个 docker daemon，因此在宝塔面板的 **Docker 管理器里能看到、能进终端、能看日志**（容器名前缀是 `infra-`，即 compose 文件所在的目录名）。之所以不让你在面板里手搓容器，是因为手搓出来的容器不在 compose 的管理范围内，下次部署对不上，且新机器要重来一遍。以 compose 文件为准，你要改数据库参数就改 `.env.deploy`。

**生产镜像在服务器本地构建**：GitHub 海外 Runner 推送广州 TCR 时，较大的 API 镜像曾长期卡在 `exporting to image`。现在传输已验证源码和 Runner 编译的 Admin 静态产物；服务器只编译 API/Worker，Admin 镜像直接复制产物，不执行 Vite。后端安装仅包含后端 workspace，构建缓存不再受 Admin/小程序源码或每次变化的构建时间影响。TCR 仍由独立的小程序上传流水线使用。

**端口一个都不对公网开放**：三个应用和两个数据库全部只绑 `127.0.0.1`，公网流量只能经宝塔 Nginx 进来。这样即使云安全组配漏了，服务也不会裸奔。

小程序**不部署到服务器**，它上传到微信平台，由 `upload-miniapp.yml` 那条独立流水线负责（见 [WECHAT_NATIVE.md](WECHAT_NATIVE.md) 第 4、5 节）。

---

## 2. 服务器前置

### 2.1 安装 Docker

宝塔面板 → **软件商店** → 搜索 **Docker 管理器** → 安装。安装完在「Docker」页签确认服务已启动。

### 2.2 确认 compose v2 可用

本方案用到 `--env-file`、`--wait`、`--exit-code-from`，这些是 **compose v2 插件**才有的能力，宝塔若装成老的 python 版 `docker-compose` 会全部报错。SSH 上服务器验证：

```bash
docker compose version
# 期望输出形如：Docker Compose version v2.2x.x
```

没有的话：

```bash
# CentOS / AlmaLinux / Rocky
yum install -y docker-compose-plugin
# Ubuntu / Debian
apt install -y docker-compose-plugin
```

### 2.3 端口与防火墙

宝塔面板 → **安全** 里放行，云厂商控制台的安全组也要同步开：

| 端口 | 用途 |
|---|---|
| 22 | SSH（GitHub Actions 部署用，建议限制来源 IP） |
| 80 / 443 | 宝塔 Nginx 站点 |
| 面板端口 | 你自己定的那个，别用默认 |

**明确不要开放**：3001、8081、5432、6379。它们只绑在 loopback 上，开了也没用，只会增加风险。

### 2.4 创建部署目录

```bash
mkdir -p /www/wwwroot/bagcollect/infra
```

`/www/wwwroot/` 是宝塔的默认站点根目录，`infra/deploy.sh` 也默认认这个路径。要换地方就改 `BAGCOLLECT_DEPLOY_DIR` 环境变量，同时把 GitHub 的 `DEPLOY_PATH` 改成一致 —— **两处必须一致**，否则脚本找不到 compose 文件。

> `infra/docker-compose.yml`、`infra/deploy.sh`、`infra/.env.deploy.example` 这三个文件由 Actions 每次部署时自动同步，不用你手工放，但 `.env.deploy`（下面要填的那个）**不在同步范围内**，服务器上自己维护。因此升级后想知道 `.env.deploy` 有没有漏掉新变量，直接在服务器上比对：
>
> ```bash
> diff /www/wwwroot/bagcollect/infra/.env.deploy.example /www/wwwroot/bagcollect/infra/.env.deploy
> ```

---

## 3. 填写服务器配置 `infra/.env.deploy`

把仓库里的 `infra/.env.deploy.example` 复制到服务器的 `/www/wwwroot/bagcollect/infra/.env.deploy`（用宝塔文件管理器上传改名最省事），然后逐项填。模板里每一行都有注释，这里只强调几个容易踩的：

**① 两个密码要用命令生成，别手敲**

```bash
openssl rand -hex 24     # → POSTGRES_PASSWORD
openssl rand -base64 48  # → JWT_SECRET
```

`POSTGRES_PASSWORD` **必须只用字母数字**。compose 会把它原样拼进 `postgresql://用户:密码@postgres:5432/库名`，密码里出现 `@ : / # ?` 会把连接串撕成两半，报出来的错是莫名其妙的 `invalid port number` 或 `getaddrinfo ENOTFOUND`。`deploy.sh` 会前置拦掉这种情况。

`JWT_SECRET` 必须 ≥32 字符，这是 API 启动时的硬校验。

**② `WECHAT_AUTH_MOCK=false`，同时填好 AppID / AppSecret**

生产环境用假登录是刻意禁止的 —— API 启动时 zod 会直接判失败。这是防止线上意外开了 mock 登录。

**③ COS 四项都要填，`COS_BUCKET` 必须带 APPID 后缀**

形如 `bagcollect-1313112155`。少写后缀的症状是 `404 NoSuchBucket`，和「桶没建」长得一模一样。

更隐蔽的一个坑：**CAM 策略里的桶名也要跟着改**。如果你换了桶名只在 `.env` 里改了、策略没改，症状会是 `403` 且上传报 `AccessDenied` —— 桶明明存在却传不上去，几乎必然是策略里的资源 ARN 还是旧桶。策略模板见 `docs/cam-policy-cos-ci.json`。

**④ `API_PUBLIC_URL` 填真实 HTTPS 地址**（不带结尾斜杠，例如 `https://api.example.com`）——**但它不是部署的前置条件**。

这个值只在 `STORAGE_DRIVER=local` 时才会被引用（`uploads.service.ts` 与 `cos.service.ts` 里都写在 `isLocal()` 分支内），而生产 compose 强制 `STORAGE_DRIVER=cos`，图片全部走 COS 直传与签名地址。所以域名还没就绪时，这里**可以先留着占位值把服务跑起来**，用服务器 IP 建站做冒烟测试，等域名备案解析好了再补。

真正需要域名的环节是小程序：`request` 合法域名必须是 HTTPS 且已在微信后台加白。这一条不影响后端启动。

**⑤ 数据库端口的默认值可能和宝塔已有服务冲突**

`POSTGRES_HOST_PORT=5432` / `REDIS_HOST_PORT=6379` 只是映射到宿主机 loopback 方便你用工具连。如果宝塔软件商店里已经装过原生 PostgreSQL 或 Redis，这两个端口会被占用，compose 报 `port is already allocated`。改成 `15432` / `16379` 即可，**不影响任何应用逻辑**（容器内部永远走 `postgres:5432` 服务名）。

---

## 4. 准备服务器本地构建环境

生产部署不再从镜像仓库拉 API/Admin，而是在服务器从固定 commit 源码和 CI 编译的 Admin 产物本地构建。服务器需要：

- Docker daemon 正常运行，并支持 BuildKit；
- Docker Compose v2；
- 建议至少 4GB 内存；2GB 机器需要 swap，两个 target 会顺序构建；
- `/var/lib/docker` 建议至少预留 8–10GB；
- 能访问 Docker Hub 与 npm registry。首次构建需要下载基础镜像和依赖，后续会命中本机 BuildKit 缓存。

工作流用 `git archive $GITHUB_SHA` 生成源码，再附上同次 CI 运行保存的 `admin-artifact/`（静态资源与 `source-sha` 标识）。源码只包含该 commit 的已跟踪文件，不包含 `.env`、密钥、`node_modules` 或本机未提交文件。服务器构建前检查 `assets/index.html` 存在且 `source-sha` 与镜像标签一致；不匹配时中止，不回退为服务器编译。发布包解压到：

```text
/www/wwwroot/bagcollect/releases/<commit>-<run>-<attempt>/
```

两个镜像都构建成功后，`build-and-deploy.sh` 才会把新版 compose/deploy 定义复制到稳定目录并调用 `deploy.sh`。因此编译失败不会改动正在运行的容器。

本地手工构建 Docker target 时，先准备后台产物（`BUILD_VERSION` 和 `BUILD_TIME` 由 Vite 注入，CI 会自动设置）：

```bash
BUILD_VERSION=$(git rev-parse HEAD) BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ') pnpm --filter @bagcollect/admin build
mkdir -p admin-artifact/assets
cp -R apps/admin/dist/. admin-artifact/assets/
git rev-parse HEAD > admin-artifact/source-sha
docker build --target admin -f infra/Dockerfile .
docker build --target api -f infra/Dockerfile .
```

`admin-artifact/` 是忽略提交的临时产物目录，Docker 构建上下文会包含它；Admin target 只使用其中的 `assets/`。`pnpm build:server` 仍可用于本地同时构建后端和后台，Docker 后端改用 `pnpm build:backend`。

TCR 配置现在只供 `upload-miniapp.yml` 使用。如果暂时不用自动上传小程序，可以不配置 TCR；需要时再按腾讯云控制台提供的账号 ID、访问密码、命名空间配置仓库级 `TCR_USERNAME`、`TCR_PASSWORD`、`TCR_NAMESPACE`。

---

## 5. 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions。

**仓库级 Secrets / Variables**（仅 `upload-miniapp.yml` 使用；不用自动上传小程序可暂不配置）：

| Secret | 说明 |
|---|---|
| `TCR_USERNAME` | 腾讯云账号 ID，见第 4.2 节 |
| `TCR_PASSWORD` | TCR 访问凭证密码，见第 4.2 节 |

**仓库级 Variables**：

| Variable | 说明 |
|---|---|
| `TCR_NAMESPACE` | TCR 命名空间，见第 4.2 节 |
| `TCR_REGISTRY` | 可选，留空即 `ccr.ccs.tencentyun.com` |

**Environment `production`**（`deploy.yml` 用到，先在 Environments 里建这个环境）：

| Secret | 说明 |
|---|---|
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | SSH 用户，宝塔一般是 `root` |
| `DEPLOY_SSH_KEY` | **私钥全文**，含 `-----BEGIN ...-----` 首尾行 |
| `DEPLOY_PATH` | `/www/wwwroot/bagcollect` |

**Environment `miniapp-development`**（`upload-miniapp.yml` 用到）：

| Secret / Variable | 说明 |
|---|---|
| `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` | 同上 |
| `WECHAT_APP_ID` | 小程序 AppID |
| `WECHAT_PRIVATE_KEY_PATH` | 服务器上代码上传私钥的绝对路径 |
| `MINIAPP_API_BASE_URL`（**Variable**） | 形如 `https://api.example.com/api` |

`DEPLOY_SSH_KEY` 的公钥要写进服务器的 `/root/.ssh/authorized_keys`。生成一对专用部署密钥：

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/bagcollect_deploy -N ""
```

> 小程序代码上传私钥**必须只放在固定出口 IP 的服务器上**，微信后台只放行那个 IP。这台宝塔服务器正好就是这个角色。

---

## 6. 域名、HTTPS 与微信合法域名

服务器在大陆，**域名必须先完成 ICP 备案**，否则 80/443 会被运营商拦掉，微信也不会给过。

1. **解析**：加 A 记录，`api.example.com` 和 `admin.example.com` 都指向服务器 IP。若用了 CDN，注意开好回源。
2. **建站**：宝塔 → 网站 → 添加站点，把两个域名各建一个站点（PHP 版本选「纯静态」即可，本方案不用 PHP）。
3. **反代**：
   - `api.example.com` → 反向代理目标 `http://127.0.0.1:3001`
   - `admin.example.com` → 反向代理目标 `http://127.0.0.1:8081`，另外**单独加一条 `/api/` 反代到 `http://127.0.0.1:3001`**（后台前端写的是同源相对路径 `fetch('/api/admin...')`）。

   也可以不用面板的反代界面，直接把 `infra/nginx/baota.snippet.conf` 里对应的 location 段粘进站点的「配置文件」。那份片段**故意不含 `listen` / `ssl_certificate`** —— 那些归宝塔管，仓库里另一个 `bagcollect.conf.example` 写死了 443 和证书路径，**不要直接用它**，会和面板托管的配置打架。

4. **HTTPS**：宝塔站点 → SSL → Let's Encrypt 一键申请，并打开「强制 HTTPS」。小程序 `request` 域名**必须是 HTTPS 且不能带端口**。
5. **微信后台合法域名**：
   - `request` 合法域名：`https://api.example.com`
   - `uploadFile`：COS 上传域名
   - `downloadFile`：COS / CDN 访问域名
6. **COS CORS**：允许小程序域名执行 `POST` 上传，只开放必要 Header。
7. **隐私保护指引**要写明「裁剪图会传给第三方云服务（腾讯云数据万象）处理」。详见 [WECHAT_NATIVE.md](WECHAT_NATIVE.md) 第 4 节。

---

## 7. 首次部署

前置都就绪后，触发流水线即可：

- **推荐**：GitHub → Actions → **Build and deploy** → Run workflow（选 `main`）。
- 或者往 `main` 推一个 commit。

它会自动完成「验证并编译 Admin → 打包固定 commit 源码与同 SHA 后台产物 → 上传发布包 → 服务器编译后端、打包后台 → 部署」。首次服务器构建需要下载基础镜像和后端 pnpm 依赖，后续部署会复用 Docker 缓存；Admin 不再在服务器重复编译。首次部署时数据库是空的，`deploy.sh` 会打印「postgres 容器未运行（首次部署），跳过备份」，这是正常的。

部署成功后创建管理员账号：

```bash
cd /www/wwwroot/bagcollect
docker compose --env-file infra/.env.deploy -f infra/docker-compose.yml run --rm \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='换成强密码' \
  --entrypoint sh api -c "node apps/api/prisma/seed.ts"
```

> `api` 镜像里带的是构建后的产物，没有 `tsx`，所以这里用 `node` 直接跑 seed 脚本；如果报找不到文件，改用本地执行 `ADMIN_USERNAME=... ADMIN_PASSWORD=... pnpm db:seed`。

自检：

```bash
cd /www/wwwroot/bagcollect
docker compose --env-file infra/.env.deploy -f infra/docker-compose.yml ps
curl -fsS http://127.0.0.1:3001/api/health/ready && echo OK
```

也可以直接在宝塔的 **Docker 管理器**里看这五个容器的状态和日志。

---

## 8. 日常运维

### 自动部署

往 `main` 推 commit，或者手动 Run workflow。部署是**串行**的（`concurrency: production-deploy`），同一时间只会有一个部署在跑 —— 两个部署并行执行迁移和切容器会互相踩。

### 看日志

```bash
cd /www/wwwroot/bagcollect
docker compose --env-file infra/.env.deploy -f infra/docker-compose.yml logs -f --tail=200 api worker
```

日志已配 10MB × 3 的轮转。**这一步别省** —— 宝塔服务器上最常见的事故就是容器日志无限增长把 `/var/lib/docker` 撑满，然后整个 docker daemon 罢工。

### 备份与恢复

- 每次部署前自动 `pg_dump` 到 `/www/wwwroot/bagcollect/backups/predeploy-<时间戳>.sql.gz`，保留 14 天。
- 恢复：
  ```bash
  gunzip -c backups/predeploy-20260924-012233.sql.gz | \
    docker compose --env-file infra/.env.deploy -f infra/docker-compose.yml exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  ```
- 建议再在**宝塔的计划任务**里加一条，把 `backups/` 目录和 docker 卷定期同步到异地。容器内的备份解决不了「整台机器挂掉」。

### 回滚

镜像回滚 = 使用服务器上保留的旧 commit SHA 本地镜像重跑 deploy.sh：

```bash
cd /www/wwwroot/bagcollect
SKIP_IMAGE_PULL=1 \
API_IMAGE=bagcollect-api:<旧SHA> \
ADMIN_IMAGE=bagcollect-admin:<旧SHA> \
sh infra/deploy.sh
```

> api 与 worker 跑的是**同一个镜像**（compose 用不同的 `command` 区分角色），所以回滚只需要两个变量，不再有 `WORKER_IMAGE`。若你的 `.env.deploy` 里还留着 `WORKER_IMAGE=` 一行，删不删都行 —— 已经没有任何地方引用它。

**数据库迁移不会回滚**，它是单向的。所以 migration 必须保持向前兼容 —— 旧版本代码要能在新 schema 上跑起来，否则镜像回滚也救不回来。这是 `deploy.sh` 顶部写明的前提，写新 migration 时请守住。

### 服务器构建慢 / 失败

- 首次构建下载基础镜像和 pnpm 依赖会比后续慢；每分钟可在 Actions 页面看到最近日志。
- Admin 的 `vite build` 应只出现在 verify 日志中；服务器 Admin target 只复制静态产物。若报产物缺失或 SHA 不一致，重新运行完整流水线以重新生成同 commit 的产物（artifact 保留 7 天）。
- 服务器上直接查看完整进度：`tail -f /tmp/bagcollect-deploy.log`。
- 出现 exit code 137 / `Killed` 通常是内存不足：增加 swap，或升级到 4GB 内存。
- Docker Hub 或 npm 下载慢时，给服务器 Docker/npm 配可用的国内镜像源；这和应用镜像大小无关。
- 构建已成功但部署失败时，`deploy.sh` 仍会恢复上一组本地镜像。

### 清理磁盘

```bash
docker image prune -f          # 清理无标签的中间层
docker system df               # 看占用
```

服务器本地构建会保留带 commit SHA 的历史镜像，方便回滚；确认旧版本不再需要后再定期 prune，至少保留当前与上一组镜像。

---

## 9. 排错表

| 症状 | 几乎必然的原因 | 处理 |
|---|---|---|
| `docker build` 报 exit code 137 / `Killed` | 服务器构建时内存不足 | 增加 swap 或升级到 4GB；API 与 Admin 已顺序构建 |
| 构建时 Docker Hub / npm 超时 | 服务器访问依赖源不稳定 | 给 Docker daemon / npm 配国内镜像源后重跑，同一 SHA 的成功层会缓存 |
| GitHub 显示 `Run Command Timeout`（红叉），但服务器仍在工作 | SSH 步骤超时，但 nohup 后台构建不会随会话退出 | `tail -n 80 /tmp/bagcollect-deploy.log`；后台完成后日志会出现「部署完成」 |
| `port is already allocated` | 5432 / 6379 被宝塔装的原生服务占了 | 改 `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` |
| `password authentication failed` | 改过 `POSTGRES_PASSWORD`，但数据卷里还是初始化时的旧密码 | PostgreSQL 只在**首次初始化**数据目录时读这个变量。要么用旧密码，要么 `ALTER USER`，要么 `down -v`（**会删库**） |
| api 容器起来就退出 | `.env.deploy` 缺 `JWT_SECRET`（<32 字符）或 `WECHAT_AUTH_MOCK=false` 却没填 AppID/AppSecret | 看 `docker compose logs api` 里的 zod 报错，它会指出具体缺哪项 |
| worker 起来就退出 | 缺 COS 凭据，或 `STORAGE_DRIVER` 不是 `cos` | worker 的配置校验是刻意的：万象读不到本地磁盘，宁可启动就失败 |
| `404 NoSuchBucket` | `COS_BUCKET` 少了 `-APPID` 后缀，或地域写错 | 无密钥探测可区分：`curl -I https://<桶名>.cos.<地域>.myqcloud.com/` → 403 说明桶和地域对；404 是桶名或地域错 |
| 上传 `AccessDenied`，但桶确实存在 | CAM 策略里的桶名没跟着 `.env` 改 | 改 `docs/cam-policy-cos-ci.md` 对应的 ARN 后重新下发策略 |
| 抠图报 `AccessDenied` | 策略少了 `ci:CreateS3AIPicMattingJob` | **每个抠图接口各自一条 `ci` action，互不通用**；切回商品抠图要补 `ci:CreateGoodsMattingJob` |
| 迁移连不上数据库 | 旧脚本直接 `up --no-deps migrate`，跳过了启动 postgres | 本仓库的 `deploy.sh` 已修：先 `up -d --wait postgres redis` 再迁移。若你是从旧版升级，确认服务器上的 `deploy.sh` 是新的 |
| 小程序报「不在以下 request 合法域名列表中」 | 域名没加白，或不是 HTTPS，或带了端口 | 微信后台加 `https://api.example.com` |
| 磁盘满了 | 容器日志或历史镜像堆积 | 见第 8 节；排查 `du -sh /var/lib/docker/*` |
| `docker compose version` 报错 | 装的是 python 版 docker-compose，不是 v2 插件 | 见 2.2 |

---

## 10. 与其它部署路径的关系

- `infra/docker-compose.local.yml` 是**本地开发**用的（5432/6390 持久化 + 5433/6380 临时测试），和生产 compose 互不影响，不要混用。
- `infra/docker-compose.yml` 现在就是**宝塔生产拓扑**。它不再是「通用 Linux 服务器」版本：端口映射、日志轮转、TZ、健康检查都按宝塔环境调过。
- 自托管 rembg / BiRefNet 的代码与镜像定义都还在（`infra/Dockerfile` 的 `rembg` target、compose 里注释掉的 `rembg` 服务、`docs/OPEN_SOURCE_MATTING.md`），但**不在主链路上**，CI 与部署矩阵也不构建它。留着是为了能回退，不用管它。
