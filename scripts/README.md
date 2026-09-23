# 项目工具

关系来源名称由 `build-source-titles.mjs` 和 `source-title-supplements.json` 维护；只有更新索引时才读取相邻游戏数据。网页构建使用后端随源码保存的名称索引。覆盖、重建和浏览器核验见[来源名称说明](../docs/SOURCE_TITLES.md)。

从仓库根目录运行 `make help` 查看统一入口。需要 Python 3.12+、uv、Node 24（最低 22.12）、npm 和 GNU Make；依赖版本由 `backend/uv.lock` 与 `frontend/package-lock.json` 管理。

首次安装执行 `make install`。它会运行 `uv sync --frozen` 和 `npm ci`，后者会重建前端依赖目录。已有环境可直接运行 `make check`，检查命令不会安装依赖。自定义虚拟环境可传入 `PYTHON=/path/to/python RUFF=/path/to/ruff`。

## 日常网站检查

`make check` 依次执行后端 Ruff、Django 系统检查、迁移漂移检查、全部现有 `atlas` 测试，以及前端类型检查、构建、游戏算法、图谱数据边界和素材工具测试。也可分别运行 `make check-backend`、`make check-frontend` 和 `make check-tools`。GitHub 的 `frontend-source` 作业执行 `make check-frontend`，覆盖随库素材校验、类型、完整构建与测试；`make check-frontend-source` 仍可用于本地快速检查。前端构建先校验随库固定素材，再生成 `frontend/public/` 与 `frontend/build/`，不读取旧 `dist/`。

后端通过 `check_backend.py` 使用独立 SQLite 内存数据库，不读取网站进程的 `DATABASE_URL`，不写入 `backend/db.sqlite3`，邮件和缓存同样使用内存。该检查不启动网站服务，也不执行社区浏览器写入流程。它检查现有测试覆盖的行为；SQLite 无法代替 PostgreSQL 的行锁、并发和数据库特性验收。

PostgreSQL 检查显式指定独立开发或 CI 基础库：

```bash
ATLAS_TEST_DATABASE_URL='postgresql://atlas_test:password@127.0.0.1:5432/atlas_check_local' make check-postgres
```

基础库须事先创建，名称必须以 `atlas_check_` 开头，连接账号须能创建测试数据库。不要填写开发网站或生产业务数据库。运行器使用随机 `test_atlas_<uuid>` 名称创建、迁移并测试临时库，正常结束后由 Django 删除。进程被强制终止时可能留下该临时库，确认名称后手动处理。`check-postgres` 包含发布、候选、匿名反馈和登录限流的多连接竞争测试；负载、容器与公网部署仍需独立验收。

## 浏览器检查与截图

所有浏览器脚本经 `playwright.mjs` 默认加载 `frontend/node_modules/playwright`；需要时用 `PLAYWRIGHT_MODULE=/absolute/path/to/playwright` 显式覆盖。首次准备浏览器可在 `frontend/` 中执行 `npx playwright install chromium`。脚本不负责启动 API 或前端，请先按[开发指南](../docs/DEVELOPMENT.md)启动对应环境，并显式提供 `BASE_URL`。

| 工具 | 用途 |
| --- | --- |
| `verify-preferences-ui.mjs` | 全 API 隔离的合成喜好验收：四视口、职业、卡面、冷却冲突、故障恢复、历史和异步切换 |
| `verify-preferences-skin-fixes.mjs` | 真实目录与素材、合成个人状态：桌面/手机重复入口、保留异格、棘刺卡面、旧详情链接及来源页不参与手势翻页；设置 `FRONTEND_URL` 指向本机前端 |
| `verify-preferences-identity.mjs` | 双榜真实 API：固定形态题、同人支持名额、本命替换、结果切换；必须显式设置 `PREFERENCES_DISPOSABLE_PREVIEW=1`，仅用于预置名录及初始快照的可丢弃本地库 |
| `verify-preferences-assets.mjs`、`contact-preferences-assets.mjs` | 喜好固定素材/完整目录校验和视觉联系表，不联网 |
| `verify-ui.mjs` | 图谱交互回归；完整应用需 `API_MODE=1`，数据数量参数应与目标数据匹配 |
| `verify-hub-ui.mjs`、`verify-motion-ui.mjs` | 高关联人物分组、分页与动效 |
| `verify-npc-ui.mjs` | NPC 范围、资料与头像 |
| `verify-game-ui.mjs`、`verify-game-illustrations.mjs` | 游戏交互及立绘 |
| `verify-game-modes.mjs`、`verify-recognition-game.mjs` | 连线模式回归、双人判断与中间人候选；使用只读本地夹具 |
| `capture-ui.mjs` | 桌面、手机及横屏截图 |
| `verify-site-notice.mjs` | 模拟 API 下的首次站点说明、5 秒倒计时与读完确认、关闭与再次打开、版本记忆、键盘和手机布局；使用 `FRONTEND_URL` |
| `verify-feedback-ui.mjs` | 模拟 API 下的反馈成功、错误、限流、键盘与移动端回归，不写业务库 |
| `verify-atlas-lifecycle.mjs` | 模拟 API 下的图谱挂载、更新、卸载及交互回归，检查资源释放 |
| `verify-section-scroll.mjs` | 只读 API 夹具下验证首页、阵营、游戏双向滚动、列表边界、滚轮惯性、触摸、历史和转场；使用 `FRONTEND_URL`，可选 `BROWSER=webkit`（WebKit 触摸仅为合成事件） |
| `verify-particles.mjs` | 模拟 API 下全部现用徽记的分形状飞入、短激光尾迹、首页进入立即重播、原生页面右键、反复悬停、快速切换、触摸拖动与布局、减少动态和 Canvas 回退；使用 `FRONTEND_URL` 指定 Vite 地址 |
| `verify-mobile-preview.mjs` | 模拟 API 下验证生产预览的慢网首屏深色底、无热更新连接、停留／断网恢复／横竖屏切换不重载或重播；使用 `FRONTEND_URL` 指定预览地址，可选 `BROWSER=webkit`（需安装该引擎） |
| `verify-live-release.mjs` | 真实本地反馈、后台处理与候选导出；必须显式授权并使用指定版本的可丢弃演练库，见 [运行要求](../docs/LIVE_RELEASE_VALIDATION.md) |
| `verify-community.mjs` | 注册、邮件验证与社区写入流程，仅供可丢弃的本地环境 |

浏览器脚本默认写入 `.runtime/verification/<类别>/`，类别为 `ui`、`hubs`、`motion`、`npc`、`game`、`game-illustrations`、`capture` 和 `community`。这些运行产物不应提交；显式保存验收证据时可用 `OUTPUT_DIR=/path/to/archive` 指定目录。`verify-ui.mjs` 与 `verify-community.mjs` 还支持 `OUTPUT_PATH=/path/to/report.json`，其优先级高于 `OUTPUT_DIR`。目录会自动创建。历史脚本默认端口和数据计数并不统一，不能直接用默认值验收所有版本。`verify-community.mjs` 还要求 `COMMUNITY_TEST_WRITES=1`、与目标 API 一致的 `DATABASE_URL` 和文件邮件配置，会创建并清理测试账号及内容；它不包含在任何 Make 检查目标中。

## 上游资料与素材维护

这些工具服务于资料重建，依赖相邻资料工程、历史 `dist/` 或素材源，不是日常修改网站所需的前置检查。新远程源码基线不包含 `dist/` 和旧 `.openai` 配置；原本地 Git 历史与 `dist/` 完整保留，需要旧原型输入时由维护者另备，不从正式构建产物反向替代。

| 工具 | 输入和结果 |
| --- | --- |
| `build-graph-data.mjs`、`validate-graph-data.mjs` | 干员资料生成和原文、方向、来源核验，依赖 `ArknightsRelationshipPilot`、`ArknightsGameData` 等相邻工程 |
| `build-npc-data.mjs`、`build-npc-data.test.mjs` | NPC 审读意见合并与重建回归，依赖相邻 `ArknightsNpcCatalog`、`ArknightsStoryCatalog` 及其引用资料 |
| `prepare-avatars.mjs`、`prepare-npc-avatars.mjs` | 头像派生，需源图及脚本要求的图像工具 |
| `prepare-game-illustrations.mjs` | 游戏立绘准备，按素材清单读取来源并生成派生文件 |
| `serve.mjs` | 查看维护者另备于根 `dist/` 的历史静态原型，新源码克隆默认不提供 |
| `*-overrides.json`、`npc-display-config.json` | 已确认的归属、复核和展示配置，修改需有资料依据 |

`make test-upstream` 先校验现有干员资料，再运行 NPC 重建测试；NPC 测试只在临时目录生成结果并清理。此目标还需要维护者另备根目录 `dist/data/` 中的历史干员资料，以及上述相邻工程，干员工程可用 `PILOT_SOURCE=/path/to/ArknightsRelationshipPilot` 覆盖，NPC 工程仍按相邻目录布局解析。资料版本或已保存计数不一致时会失败，需要核实来源，不能通过放宽断言掩盖差异。

需要正式重建时先查看根 README、`docs/NPC_IMPORT.md` 和 `docs/GAME.md` 的对应说明，向新目录输出并检查差异。重建 JSON 只形成候选，核实后通过[后台修订](../docs/EDITORIAL_WORKFLOW.md)审核发布；`data/source/` 用于初始化和单向归档，不能重新生成或导入旧包覆盖已维护的正式资料。

## 开放字体维护

`prepare_ofl_fonts.py` 仅处理已核对的思源黑体及 Oswald 子集，按固定 SHA-256 接受输入，保留字形与排版表，调整派生名称并嵌入 OFL。使用 `uv run --script` 读取脚本声明的独立依赖；不是日常构建步骤，也不处理商业字体。复现命令、来源及许可见 [字体维护](../docs/ASSET_LICENSING.md#开放字体的维护)。

## 资源校验与归档

`resource_pack.py` 提供固定清单的生成、校验、打包和恢复；当前清单对应素材已随源码提交，日常使用 `make assets-verify`。`make assets-install ASSET_PACKAGE=...` 仅用于可选离线恢复，完整参数见 [素材说明](../docs/RESOURCE_PACK.md)。

## 后台浏览器验收

`verify-editorial-ui.mjs` 仅对回环地址的可丢弃测试站写入，要求 `ATLAS_EDITORIAL_TEST_WRITES=1`、`BASE_URL` 和 `EDITORIAL_TEST_AUTH`。凭据 JSON 包含测试账号 `username`、`password` 及测试反馈 `feedback` ID，不提交仓库。使用 `atlas.test_releasing` 的测试基线 `test-1`、配套测试资源清单及专用数据库；不要指向业务库。脚本验证关联新增资料、审核、发布、反馈结案、快照导出及回退，截图和报告写入 `.runtime/verification/editorial/`。

## 喜好 V2

- `prepare-preferences-metadata.mjs`：显式固定元数据输入，完整形态、外观与剧情单元分母。
- `prepare-preferences-npcs.py`：固定剧本文本/树、候选发言上下文；提取不等于入选，须维护审读结果。
- `prepare-preferences-npc-assets.mjs`、`prepare-preferences-assets.mjs`：NPC与完整外观、原图摘要、V1保留、实际覆盖；更新时指定新 `--catalog-version`。
- `prepare-preferences-portraits.py`：已校验脸部模型提供建议，保留逐图裁切/复核；需可选 assets 依赖，普通构建不需OpenCV。
- `contact-preferences-portraits.mjs`：全量半身联系表；`verify-preferences-assets.mjs` 独立核对元数据分母、实际文件和旧版保留。
- `verify-preferences-ui.mjs`：四视口合成接口、50次休息、原操作重试、卸载与迟到请求。
- `verify-preferences-v2-real.mjs`：四视口真实API/素材/触控/网络，必须显式设置 `PREFERENCES_DISPOSABLE_PREVIEW=1` 并使用事先新建的可丢弃本地库。产生少量真实登记表中的合成动作，不可指向业务库。

素材流程与复现命令见 [喜好素材](../docs/PREFERENCES_ASSETS.md)，结果见 [V2验收](../docs/PREFERENCES_V2_ACCEPTANCE.md)。
