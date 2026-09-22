# 真实后端浏览器演练

`scripts/verify-live-release.mjs` 对真实本地 Django/PostgreSQL 服务执行访客反馈、后台处理和资料候选验收，不模拟 API 响应。它会在可丢弃演练库中创建两条私有反馈和一条候选，不应用候选、不改正式原文、不向 GitHub 写入。

运行前需要准备由备份恢复、完成迁移和发布回退的独立演练库，并启动相应 API 与前端代理。不得使用现有业务服务。脚本没有默认目标地址，要求显式环境授权、localhost 地址，以及 `/api/ready/` 返回 `rehearsal-revert` 发布版本；每次浏览器写请求前再次核对版本，非本站网络请求被阻止。这些检查不能代替操作者确认数据库确实可丢弃。

```bash
ATLAS_LIVE_REHEARSAL=1 BASE_URL=http://127.0.0.1:5175 ATLAS_BROWSER_CREDENTIALS=/path/to/private/browser-credentials.json node scripts/verify-live-release.mjs
```

本地 Caddy HTTPS 演练另需显式设置 `ATLAS_LOCAL_HTTPS=1`。先从**本次可丢弃 Caddy 实例**导出公开的根 CA 证书到项目临时目录，再用其绝对路径设置 `NODE_EXTRA_CA_CERTS`，必须在 Node 进程启动前设置，不向宿主信任库安装证书。示例中的证书与凭据路径须替换为实际文件：

```bash
ATLAS_LIVE_REHEARSAL=1 ATLAS_LOCAL_HTTPS=1 BASE_URL=https://localhost:18443 NODE_EXTRA_CA_CERTS=/absolute/project/.runtime/rehearsal/caddy-root.crt ATLAS_BROWSER_CREDENTIALS=/path/to/private/browser-credentials.json node scripts/verify-live-release.mjs
```

Node 的 readiness 请求仍执行 TLS 证书链与主机名校验；缺少、不可信或不匹配的 CA 会阻止继续，`NODE_TLS_REJECT_UNAUTHORIZED=0` 被直接拒绝。HTTPS 模式只允许 `localhost` 或 `127.0.0.1`，仍拒绝端口 8000，不允许 URL 凭据、查询参数、片段或 readiness 重定向。首次及每次浏览器写入前都由 Node 确认 `rehearsal-revert` 版本。

浏览器例外：仅在上述显式本地 HTTPS 模式下，对本次 Playwright context 设置 `ignoreHTTPSErrors: true`，因 Chromium 不使用 Node 的额外 CA 配置。这不是浏览器证书校验通过的证明，也不是公网 TLS 验收。浏览器仍拦截全部非目标 origin 请求，并禁用 Service Worker，防止其绕过请求拦截；Node 请求不采用此例外。HTTP 演练不会启用浏览器证书例外。

凭据文件结构为包含 `username` 和 `password` 的 JSON，使用仅存在于演练库的维护者账号；真实密码不写入脚本、报告、截图或命令参数。脚本使用项目锁定的 Playwright，默认输出到 `.runtime/verification/live-release/`，可通过 `OUTPUT_DIR` 指定另一运行目录。需要本机 Chromium 运行环境和 Python 3（用于只读检查浏览器下载的 ZIP）。

验收步骤：

- 桌面与手机通过真实表单提交反馈，确认请求携带 CSRF，得到收件提示且没有横向溢出。
- 确认无 CSRF 的匿名提交被拒绝、私有反馈没有公开列表，旧社区入口关闭。
- 从实际图谱打开关系原文，与真实只读 API 核对，并加载游戏和可选下一步。
- 使用维护者后台登录，查找本次演练反馈、填写处理理由并保存状态；确认已认证账号仍不能写旧收藏接口。
- 从正式证据详情创建候选，在字段表单修改原文、来源、行号和版本，保存并查看差异。
- 同时打开的旧候选页面再次保存须收到版本冲突；正式关系 API 的完整响应在候选操作前后保持一致。
- 通过后台按钮下载 ZIP，核对基线、候选版本和来源字段，确认私有备注没有进入导出。

结果保存在 `report.json`；截图包括桌面/手机反馈、关系原文、游戏、处理后的反馈和已遮盖私有备注的候选差异。下载包仅含演练候选，不提交源码仓库。脚本不自动删除数据库记录，以保留核查证据；完成后按演练流程销毁整个临时库。失败重跑也会留下已完成步骤的私有记录，每轮完整运行占用两次反馈配额；遇到限流时使用新的可丢弃演练库或等待窗口到期，不绕过生产限流。

本脚本只覆盖上述访客与维护者闭环，不替代全部图谱生命周期、真实手机设备、无障碍或公网部署验收；当前开发与数据库检查见[开发指南](DEVELOPMENT.md)。维护者浏览器使用演练管理员；细粒度候选和反馈权限另由后端权限回归覆盖。
