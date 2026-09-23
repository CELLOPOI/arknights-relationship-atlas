# 容器构建与版本清单

`Checks` 先执行 `frontend-source` 和 `backend-postgres`，再分别构建、检查 API 与 Web 运行镜像。PR 只构建验证；推送到 `main` 或在 `main` 手动运行工作流时，使用该任务的 `GITHUB_TOKEN` 发布到 GHCR。镜像任务只有读取源码和写入 Packages 的权限，最终发布任务只有写入 Releases 的权限。工作流不使用实例连接信息、业务数据库或部署密钥。

两个镜像的地址为 `ghcr.io/<owner>/<repository>-api:sha-<commit>` 和 `ghcr.io/<owner>/<repository>-web:sha-<commit>`，仓库路径转为小写，当前构建平台为 `linux/amd64`。OCI 标签记录源码仓库、完整程序提交和基础素材版本。通用 Web 镜像不注入访问统计标识；使用代理自动安装统计，或另行构建带运行方标识的镜像。

两项运行镜像检查均通过后，工作流发布 `images-<完整提交>` Release。镜像已上传但运行检查失败时不会生成 Release；消费者应以完整 Release 为入口。发行附件只含以下显式选择的文件：

| 文件 | 契约 |
| --- | --- |
| `release.json` | 格式版本、源码提交、平台、素材版本、API/Web 的完整镜像摘要引用、附件摘要 |
| `compose.yaml` | 通用容器契约，不包含实例配置 |
| `resource-manifest.json`、`preferences-manifest.json` | 固定素材清单 |
| `SHA256SUMS` | 上述文件的 SHA-256 校验清单 |

使用 `release.json` 中的 `image@sha256:…` 引用确定镜像内容。SHA 标签便于查找，但工作流重跑时可能重新构建；已公开 Release 的清单保持原内容，避免改变已使用的版本。发布先形成草稿，附件完整后公开；工作流中断后可重跑以完成草稿。只有一个镜像构建成功时不会形成可使用的双镜像 Release。

GHCR 的包可见性独立于源码仓库，首次发布的包默认私有。维护者按项目要求在两个 Package 的设置中配置访问权限；公开包可以匿名拉取。构建工作流本身不需要配置长期 Packages 密钥。参考 [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 分层与缓存

Web 构建仍校验全部素材并执行前端测试。`frontend/scripts/container-layers.mjs` 根据完整 `public/` 文件清单，将固定图片、字体、索引和许可文件移入独立层，Vite 生成的 HTML、JavaScript 和 CSS 留在应用层。两层叠加后保留原 URL 和文件内容。若构建文件覆盖了同名公共素材，分层步骤拒绝继续。

API 将运行依赖、喜好素材、素材清单、名录和 Python 源码分层，运行环境只复制依赖虚拟环境，不携带 uv 下载缓存。使用 `COPY --chown` 设置文件归属，不在最终层递归修改全部素材。两个镜像的固定素材层都规范化文件时间，减少干净检出时间造成的摘要变化。

CI 按 API/Web 分别保存 BuildKit 缓存。缓存缺失只影响构建开销，不影响正确性。Docker 拉取复用已存在的相同层，下载的是缺失层的完整内容；不是任意文件的二进制补丁。首次拉取、基础镜像变化或素材变化仍可能产生较大下载。不得把固定素材与应用重新合成一个最终复制层。设计取舍见[工程决定](../.agents/notes/implemented/architecture/2026-09-23-container-registry-releases.md)。

## 验证与边界

`make check-tools` 验证分层前后路径与内容、静态文件冲突、版本清单摘要、混合提交拒绝，以及只选择通用文件。PR 的 `container-api` / `container-web` 使用真实 Docker 构建并检查最终运行镜像。程序检查仍保留原有的前端与 PostgreSQL 必需检查名称。

Release 表示镜像可供获取，不表示任何实例已经更新。资料的审核发布、数据库结构迁移和实例切换仍有各自的状态；发布镜像不导入 Git 资料，也不触发实例更新。个人更新、备份、回退工具及真实配置继续在源码仓库外维护。
