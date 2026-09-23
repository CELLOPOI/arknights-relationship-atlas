# 本地开发与检查

使用 Python 3.12、uv、Node 24、npm 和 GNU Make；版本及依赖由根运行版本文件、`backend/uv.lock` 与 `frontend/package-lock.json` 固定。生产和并发验收使用 PostgreSQL，SQLite 只用于快速检查或本地体验。

## 安装与校验

在仓库根目录执行：

```bash
make install
make assets-verify
make check
```

固定版本素材随仓库提供，无需导入资源包；`assets-install` 仅用于可选离线恢复。素材来源、清单与许可边界见[素材说明](RESOURCE_PACK.md)。构建不依赖历史 `dist/` 或相邻资料工程。

`make check` 使用独立内存 SQLite，执行后端静态检查、迁移检查、测试、前端类型检查、生产构建、游戏/图谱边界测试及素材和资料工具检查。它不连接业务 `DATABASE_URL`，不启动网站，不写入真实反馈。需要真实行锁验收时：

```bash
ATLAS_TEST_DATABASE_URL='postgresql://atlas_test:password@127.0.0.1:5432/atlas_check_local' make check-postgres
```

基础库必须已存在、名称以 `atlas_check_` 开头，测试账号须有建库权限。运行器创建随机测试库，正常结束后删除；不能填网站业务库。PostgreSQL 测试覆盖反馈限流、候选/发布竞争及发布期间的读取一致性；不代表容量或生产部署验收。

## 启动可丢弃的开发环境

以下示例面向尚无 `backend/db.sqlite3` 的首次本地体验，会写入该文件。已有开发库先备份并核实其状态；已有正式资料按 [基线核对](DATA_SOURCE.md) 处理，不能清库重导。本地开发不得使用业务数据库或真实用户资料。

```bash
export DJANGO_DEBUG=1 DATABASE_URL=''
backend/.venv/bin/python backend/manage.py migrate --noinput
backend/.venv/bin/python backend/manage.py createcachetable
backend/.venv/bin/python backend/manage.py build_data_release --source data/source --release-id local-v1 --asset-version atlas-assets-24d6e8427efd2e90f29f1b7e --output .runtime/releases/local-v1.json --allow-dirty
backend/.venv/bin/python backend/manage.py release_data --package .runtime/releases/local-v1.json --preview .runtime/releases/local-v1-preview.json
# 阅读预览中的资料差异后应用。
backend/.venv/bin/python backend/manage.py release_data --package .runtime/releases/local-v1.json --apply .runtime/releases/local-v1-preview.json
backend/.venv/bin/python backend/manage.py createsuperuser
backend/.venv/bin/python backend/manage.py runserver 127.0.0.1:8000
```

输出文件拒绝覆盖，重复演练时使用新的文件名；新的发布还须声明实际上一版本。`--allow-dirty` 只用于未提交工作区的 DEBUG 演练，生产拒绝应用。后台资料修订、审核与回退步骤见 [资料发布](DATA_RELEASES.md) 与 [后台维护](EDITORIAL_WORKFLOW.md)。

另开终端运行 `npm --prefix frontend run dev`，访问 [首页](http://127.0.0.1:5173/)、[完整人物范围](http://127.0.0.1:5173/?scope=all#factions)、[游戏](http://127.0.0.1:5173/game/) 和 [后台](http://127.0.0.1:5173/admin/)。默认同源代理连接 8000 端口；隔离演练可设置 `ATLAS_API_URL=http://127.0.0.1:8130`。开发服务仅监听回环地址。

手机持续体验使用生产构建预览。开发服务带有热更新连接，源码变更或连接断开后恢复可能触发整页重载，不能据此判断粒子动画在自动循环。以下构建单独存放，避免其他开发检查重建 `frontend/build/` 时干扰正在浏览的版本：

```bash
npm --prefix frontend run build -- --outDir ../.runtime/mobile-preview --emptyOutDir
npm --prefix frontend run preview -- --outDir ../.runtime/mobile-preview --host <本机局域网IP> --port 5177 --strictPort
```

将占位 IP 换成本机的实际局域网地址，手机在同一网络打开 `http://<本机局域网IP>:5177/`。沿用已有开发 API，并按其配置允许该 Host 和同源来源。此入口不含热更新客户端；更新预览内容需要重新执行上述构建并手动刷新。它仍是本地体验服务，不代替正式部署。页面 HTML 自带深色底，应用脚本尚未加载时也不露出默认白底。

旧社区默认关闭，既有普通账号也不能继续评论、收藏或旧投稿。游客可看资料、玩游戏和提交匿名反馈；后台通过独立权限处理反馈与候选。默认 `FORMAL_DATA_MANAGED=1` 阻止后台和旧导入器改正式资料。只有历史兼容测试允许在 DEBUG 下显式关闭，不能作为日常资料维护方式。

## 浏览器与上游回归

浏览器工具复用前端锁定的 Playwright。首次安装 Chromium：

```bash
cd frontend
npx playwright install chromium
```

先启动 API 与前端，再从根目录执行对应检查。读取当前全量基线的图谱回归示例：

```bash
BASE_URL=http://127.0.0.1:5173 API_MODE=1 EXPECTED_OPERATOR_EDGES=3703 EXPECTED_ALL_ROOT_ENTRIES=25 node scripts/verify-ui.mjs
```

`verify-feedback-ui.mjs` 与 `verify-atlas-lifecycle.mjs` 使用隔离模拟 API，验证错误状态、移动端和卸载资源，不证明真实反馈入库。真实写入验收使用可丢弃的本地数据库和合成测试数据。旧社区脚本只为显式开启社区的兼容测试保留，不在首版访客检查中运行。默认产物位于 `.runtime/verification/`，更多入口见 [工具说明](../scripts/README.md)。

`make test-upstream` 单独运行，要求具备相邻资料工程。上游重建只形成审读材料与候选差异，经后台修订审核发布，不覆盖人工维护结果。代码升级执行迁移，保留当前正式版本，不能再次应用初始资料包。`.runtime/`、数据库、资源压缩归档、生成的 `frontend/public/` 和 `frontend/build/` 均不提交；当前固定清单对应的素材目录随库维护，边界见 [仓库文件约定](REPOSITORY_POLICY.md)。

## 可选访问统计

使用 Cloudflare 橙云代理时，优先在 Web Analytics 中启用自动安装，后续应用发布无需携带统计标识。此时保持下述构建变量为空，避免手动脚本与自动安装同时启用。灰云直连或明确选择手动安装时才使用构建注入。

生产构建支持 Cloudflare Web Analytics 的手动脚本接入。将后台代码中的 `token` 配置为 `CLOUDFLARE_WEB_ANALYTICS_TOKEN`：本地 npm 构建可放在已忽略的 `frontend/.env.production.local`；Compose 构建放在根目录 `.env`；独立镜像构建通过同名 `--build-arg` 传入。标识会出现在发布后的 HTML 中，但实际站点配置不提交仓库。

未配置或留空时不输出统计脚本，开发服务与非 production 模式不注入。生产构建在 `</body>` 前添加 Cloudflare 的外部 module 脚本，保留其默认 SPA 统计；不用在页面切换时重复安装。使用带统计的构建做本地浏览器验收时应拦截统计请求，避免测试流量进入报表。

变量只在构建时读取，修改后需要重新构建并发布 Web 镜像；给已运行的容器补环境变量不会改变网页。通过 Git 归档制作交付时，本地 `.env.production.local` 不会进入归档，交付构建器必须显式传入构建参数。后台选择手动 JS 安装，避免与代理自动注入重复。接入后验证发布 HTML 中仅有一个 `data-cf-beacon` 脚本，再检查实际浏览器上报和统计后台；构建通过不代表报表已经收到数据。参见 [Cloudflare 接入说明](https://developers.cloudflare.com/web-analytics/get-started/)。

## CDN 与访客地址

默认 `CADDY_TRUSTED_PROXY_CIDRS` 留空，Caddy 使用直连地址，忽略访客自行设置的转发头。启用 CDN 前，在部署 `.env` 中填入入口代理实际使用的来源 CIDR，空格分隔。Cloudflare 使用其[官方 IPv4](https://www.cloudflare.com/ips-v4/)和[IPv6](https://www.cloudflare.com/ips-v6/)列表，不信任全部公网、全部私网或仅凭一个请求头判断代理身份。

Caddy 只对受信任连接从右向左解析 `X-Forwarded-For`，再将已确定的单个 `{client_ip}` 传给 API。Django 仍只信任 Compose 中固定的 Caddy 地址，不需要添加 CDN 网段。这样直连与代理入口都能保持反馈、后台登录和喜好接口的访客限流隔离；不能改回 `{remote_host}`，也不能直接使用未经来源验证的 `CF-Connecting-IP`。

这些网段属于运行配置，正常更新镜像时继续沿用部署 `.env`。代理提供商更改来源网段时单独维护并重建 Web 容器；不需要每次应用发布重新填写。Cloudflare 应使用 Full (strict)，源站继续由 Caddy 管理有效证书；保留证书持久卷及 HTTP 证书验证通路。后台、写入接口和就绪检查不配置强制缓存或浏览器挑战，开启代理后复查 HTTPS、静态资源、登录与状态监控。

本地安装 Caddy 2.8 或更新版本后，运行 `backend/.venv/bin/python scripts/verify_caddy_proxy.py --caddy /path/to/caddy`。脚本使用实际 Caddy 配置与本机临时回显服务，验证直连、不可信代理、可信代理、IPv4/IPv6 和伪造请求头，共 36 个请求断言，不连接真实数据库或网站。

设计理由与验证边界见[代理入口与访问统计](../.agents/notes/implemented/architecture/2026-09-23-cdn-and-web-analytics.md)。

## 启用喜好目录

迁移后按[喜好开发说明](PREFERENCES.md)将固定候选名录建立草稿、审核、预览并发布，再运行 `aggregate_preferences`。这条流程独立于正式人物资料，不关闭资料保护或旧社区开关。前端同时校验旧素材和 `assets/preferences-manifest.json`；普通构建不下载图片。喜好模拟浏览器验收使用 `FRONTEND_URL=http://127.0.0.1:5173 node scripts/verify-preferences-ui.mjs`；真实写入和备份恢复必须使用可丢弃数据库。

喜好首版升级到V2时，不重导正式资料基线；先迁移已有结构、校验固定素材，再将 `people-supplement.json` 送入资料修订，最后独立发布喜好名录与重算统计。完整命令、数据库隔离要求及本轮本地预览见 [喜好运行说明](PREFERENCES.md)和[V2验收](PREFERENCES_V2_ACCEPTANCE.md)。
