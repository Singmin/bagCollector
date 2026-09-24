# BagCollect 部署到宝塔服务器（GitHub Actions 自动化）

面向宝塔面板（aaPanel）+ Docker 的部署手册。CI/CD 由 GitHub Actions 驱动，仓库里已经配好，本文只讲怎么把它接到你的服务器上。

抠图走腾讯云数据万象，是云端按次计费接口，**服务器上不需要任何推理服务**，所以 2 核 2G 也跑得起来。

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
   ├─ verify   复用 ci.yml：lint → typecheck → 单测 → 迁移 → 构建
   ├─ images   构建 api / admin 两个镜像，打 commit SHA 标签，推 GHCR
   │             （api 这个镜像同时跑 api 与 worker 两个容器，见第 5 节）
   └─ deploy   SSH 到服务器
                 ├─ docker login ghcr.io
                 ├─ scp infra/{docker-compose.yml,deploy.sh,.env.deploy.example}
                 └─ sh infra/deploy.sh
                       备份库 → 拉镜像 → 起 postgres/redis → 跑迁移
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

**关于「数据库也是容器」**：`postgres` 与 `redis` 由同一个 compose 文件统一下发，跑在你宝塔那台机器的 Docker 里。它们和 api/worker/admin 是同一个 docker daemon，因此在宝塔面板的 **Docker 管理器里能看到、能进终端、能看日志**（容器名前缀是 `bagcollect-`）。之所以不让你在面板里手搓容器，是因为手搓出来的容器不在 compose 的管理范围内，下次部署对不上，且新机器要重来一遍。以 compose 文件为准，你要改数据库参数就改 `.env.deploy`。

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

## 4. 授权服务器拉取私有镜像

仓库是公开的，但 **GHCR 上的 package 默认是私有的**，不登录就 `docker pull` 会 403。这一步不做，首次部署必定失败。

### 方式 A：配成 GitHub Secrets（推荐）

1. 打开 <https://github.com/settings/tokens/new>（或者：右上头像 → **Settings** → 左侧栏最下方 **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**）。
2. Note 填 `bagcollect-deploy`，Expiration 按你的习惯选。
3. Scopes 勾 **`read:packages`**；**如果这个仓库是私有的，再补一个 `repo`**。
   - **怎么判断仓库是不是私有**：用未登录的浏览器打开 `https://github.com/<你的用户名>/<仓库名>`。能直接看到代码就是公开；要求登录、或返回 404，就是私有。
     另一个等价的判断：`curl -s -w '\n%{http_code}\n' https://api.github.com/repos/<你的用户名>/<仓库名>` → `200` 公开、`404` 私有。
   - **为什么私有仓库还需要 `repo`**：GHCR 上的包默认**继承所属仓库的可见性**。包挂在私有仓库下时，GitHub 要求 `repo` scope 才放行只读拉取 —— 这是 GitHub 的限制，不是 scope 配错了。缺它的话症状是 pull 报 `denied: denied`，而 `docker login` 本身是成功的，很容易误判成「token 无效」。
   - **不确定就两个都勾**，多勾一个 `repo` 不会有坏处。
   - **不需要 `write:packages`** —— 推镜像的是 Actions 自带的 `GITHUB_TOKEN`（工作流里已声明 `permissions: packages: write`）。
   - **不需要 `read:org`** —— 那是有组织 SSO 时才要。
4. 生成后**立刻复制** —— GitHub 只显示这一次，关掉页面就再也看不到。
5. 在仓库 Secrets 里加 `GHCR_USER`（你的 GitHub 用户名）和 `GHCR_TOKEN`（刚生成的 token）。

之后每次部署 `deploy.yml` 会自动在服务器上执行 `docker login`，你换 token 也不用登服务器。

> **Expiration 是个真实的坑**：token 一过期，部署会在「拉取镜像」这一步开始报 403，而报错完全不会提示「token 过期了」。要么选 No expiration（省事，安全性略低），要么设个提醒到期前换掉。
>
> 想用更细粒度的 **fine-grained token** 也可以：Developer settings → Fine-grained tokens → 生成时把 **Packages** 权限设为 **Read**。功能等价，就是权限范围更小。

### 方式 B：服务器上手工登录一次

```bash
echo '<你的PAT>' | docker login ghcr.io -u '<你的GitHub用户名>' --password-stdin
```

凭据会落在 `/root/.docker/config.json`，`deploy.sh` 直接复用。没配 `GHCR_TOKEN` 时工作流会走这条路。

验证登录是否生效（首次部署推过镜像之后才拉得到）：

```bash
docker pull ghcr.io/<你的用户名>/bagcollect-api:latest
```

### 方式 C：把 package 改成公开

在 GitHub 上把三个 package 的可见性改成 Public，服务器就完全不需要登录。最省事，也不用管 token 过期，代价是任何人都能拉你的镜像（镜像里没有密钥，密钥只在服务器的 `.env.deploy` 里）。改法是：首次部署推上镜像后，打开 `https://github.com/users/<你的用户名>/packages` → 逐个进入 → Package settings → Change visibility。

选这条路的话，`GHCR_USER` / `GHCR_TOKEN` 可以完全不配 —— `deploy.yml` 里检测到 token 为空会跳过登录步骤。

---

## 5. 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions。

**Environment `production`**（`deploy.yml` 用到，先在 Environments 里建这个环境）：

| Secret | 说明 |
|---|---|
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | SSH 用户，宝塔一般是 `root` |
| `DEPLOY_SSH_KEY` | **私钥全文**，含 `-----BEGIN ...-----` 首尾行 |
| `DEPLOY_PATH` | `/www/wwwroot/bagcollect` |
| `GHCR_USER` | 见第 4 节，可选 |
| `GHCR_TOKEN` | 见第 4 节，可选 |

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

它会自动完成「验证 → 构建镜像 → 同步部署文件 → SSH 部署」。首次部署时数据库是空的，`deploy.sh` 会打印「postgres 容器未运行（首次部署），跳过备份」，这是正常的。

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

镜像回滚 = 用旧的 commit SHA 重跑 deploy.sh：

```bash
cd /www/wwwroot/bagcollect
API_IMAGE=ghcr.io/<你的用户名>/bagcollect-api:<旧SHA> \
ADMIN_IMAGE=ghcr.io/<你的用户名>/bagcollect-admin:<旧SHA> \
sh infra/deploy.sh
```

> api 与 worker 跑的是**同一个镜像**（compose 用不同的 `command` 区分角色），所以回滚只需要两个变量，不再有 `WORKER_IMAGE`。若你的 `.env.deploy` 里还留着 `WORKER_IMAGE=` 一行，删不删都行 —— 已经没有任何地方引用它。

**数据库迁移不会回滚**，它是单向的。所以 migration 必须保持向前兼容 —— 旧版本代码要能在新 schema 上跑起来，否则镜像回滚也救不回来。这是 `deploy.sh` 顶部写明的前提，写新 migration 时请守住。

### GHCR 拉取不稳定（大陆服务器）

`ghcr.io` 的镜像层实际存放在 `pkg-containers.githubusercontent.com`，这个域名从大陆访问**经常在 TLS 握手阶段超时**。典型表现是下载到一半（例如 `Downloading 112.2MB` 之后）报 `net/http: TLS handshake timeout`，而 `docker login` 其实是成功的 —— **极易误判成鉴权问题**。

`deploy.sh` 已内置 3 次重试，一般就够（已下载的层会保留，所以重试很便宜）。如果每次都失败、或不想赌链路，有三条路：

1. **把三个 package 改成 Public**（见第 4 节方式 C）。少一次鉴权往返，成功率会好一些，但仍走同一条 CDN，不保证解决。
2. **给 Docker 配 HTTP 代理**（你若有可用代理）：
   ```bash
   mkdir -p /etc/systemd/system/docker.service.d
   cat > /etc/systemd/system/docker.service.d/proxy.conf <<'EOF'
   [Service]
   Environment="HTTP_PROXY=http://<代理地址>:<端口>"
   Environment="HTTPS_PROXY=http://<代理地址>:<端口>"
   EOF
   systemctl daemon-reload && systemctl restart docker
   ```
   > 顺带纠一个常见误解：`daemon.json` 里的 `registry-mirrors` **只对 Docker Hub 生效，对 ghcr.io 无效**。给 ghcr.io 加速必须走代理，或者照下面第 3 条换仓库。
3. **换用国内镜像仓库**（服务器在腾讯云的话推荐 TCR，拉取走内网、几乎免费）：把 `deploy.yml` 里 `ghcr.io/<用户名>/...` 换成 TCR 地址，登录方式换成 TCR 凭据，`.env.deploy` 的三个 `*_IMAGE` 同步改。**改动只集中在这两处，`deploy.sh` 完全不用动。**

### 清理磁盘

```bash
docker image prune -f          # 清理无标签的中间层
docker system df               # 看占用
```

`deploy.sh` 每次只保留当前和上一组应用镜像，历史镜像会堆积，觉得占地方就定期 prune。

---

## 9. 排错表

| 症状 | 几乎必然的原因 | 处理 |
|---|---|---|
| `pull access denied` / `403 Forbidden` 拉镜像失败 | GHCR 是私有包但服务器没登录 | 见第 4 节 |
| `docker login` 成功，但 pull 报 `denied: denied` | PAT 缺 `repo` scope，而包挂在**私有**仓库下 | 给 token 补 `repo`（见第 4 节方式 A 第 3 步），或把三个 package 改成 Public |
| 拉取镜像报 `TLS handshake timeout` / `net/http` / `i/o timeout` | 服务器在大陆访问 GHCR 的层 CDN（`pkg-containers.githubusercontent.com`）握手超时 —— **跟鉴权完全无关** | `deploy.sh` 已内置 3 次重试（已下载的层会保留，重试成本很低）。持续失败见第 8 节「GHCR 拉取不稳定」 |
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
