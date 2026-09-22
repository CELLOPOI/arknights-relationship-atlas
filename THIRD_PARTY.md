# 来源与许可状态

本项目原创代码采用 [MIT](LICENSE)。游戏图片、字体、商标、剧情原文、第三方依赖及参考实现保留各自权利；`data/source/`、`data/npc/` 中的第三方表达也不属于代码许可授予范围。

当前固定素材与来源元数据随源码分发，使开发者能够从克隆直接构建。素材清单保持 `rights_status: unreviewed`；仓库收录及维护者的提交许可不等于第三方对全部用途的授权。进一步许可核对按 [项目约定](AGENTS.md#当前许可核对范围)暂缓，已有版权和许可文件继续保留。

| 内容 | 来源记录 | 当前状态 |
| --- | --- | --- |
| 前后端依赖 | `frontend/package-lock.json`、`backend/uv.lock` | 保留依赖随附许可，构建生成前端运行依赖声明 |
| 干员头像 | [素材清单](assets/manifest.json) | 固定来源提交与校验值，美术权利归各权利人 |
| NPC 头像 | [NPC 清单](assets/npc-manifest.json) | 保留来源页、裁切与哈希 |
| 游戏立绘与异格 | [立绘清单](assets/illustration-manifest.json)、[异格清单](assets/appearance-manifest.json) | 固定输入版本与派生记录 |
| 徽记与字体 | 素材目录内 `assets/emblems.json`、`assets/fonts.json` | 保留官方来源、版权及许可链接；字体细节见下文 |
| 参考站点适配 | [参考学习](docs/SOURCE_LEARNING.md) | 区分独立实现与参考适配 |
| 剧情原文与关系资料 | [NPC 接入](docs/NPC_IMPORT.md)、`data/npc/` | 保留出处、方向与原文对应 |

随库资源目录和校验方式见 [素材说明](docs/RESOURCE_PACK.md)，完整文件清单见 [资源清单](assets/resource-manifest.json)。来源记录用于追溯，不代替使用许可。

## 依赖声明

前端实际分发 Vue 的 `@vue/shared`、`@vue/reactivity`、`@vue/runtime-core`、`@vue/runtime-dom`，以及 Vite 注入的预加载辅助代码。构建脚本 `frontend/scripts/prepare-notices.mjs` 从实际安装的锁定版本读取原始许可：四份 Vue MIT 文本相同时合并并列出模块及版本；Vite 只取 core MIT 段，不把所有构建工具依赖误列为网站运行依赖。生成 `/assets/licenses/frontend-dependencies.txt`，与原始版权短注释一起保留。版本、许可标识或 Vite 文本结构不符时构建失败；该文件独立于固定游戏素材包。

后端已安装的九个生产 Python 包与 `backend/uv.lock` 对应，其 `dist-info` 中自带的许可文件由现有 Dockerfile 完整保留 `.venv` 的步骤复制；这不等于完成全部依赖的法律审查。Django/DRF/asgiref/sqlparse 的 BSD、Gunicorn 的 MIT、packaging 的双许可文件及 typing_extensions 的 PSF 声明均存在。Django 后台静态资源中的 jQuery、Select2、XRegExp 许可也须随对应文件保留。

`psycopg-binary` 还带有 libpq、OpenSSL 等共享库；保留包内许可及 auditwheel SBOM，进一步核对按上述执行范围暂缓。当前没有更换驱动，也没有将这些组件改标为 MIT。官方安装与打包范围见 [Psycopg 安装说明](https://www.psycopg.org/psycopg3/docs/basic/install.html)。基础镜像的系统包保留各自许可。

## 素材与字体

Novecento Sans Wide Bold 使用官方 Webfont kit 的原样 WOFF2，保留原始 CSS/HTML notice 和许可链接，不纳入 MIT。Bender Bold 仍缺与现用字重相符的完整依据；公开来源不等于已核实再分发范围。文件版本、哈希和字体维护步骤见 [素材与字体来源](docs/ASSET_LICENSING.md)。

明日方舟美术、商标和原文属于各自权利人，含涉及联动的内容；本项目是非官方资料工具。

## 开放字体子集

三款既有子集包含 OFL 1.1 许可标记，当前按其对应版本的保留字体名要求制作改名派生文件。原始版权记录保留；`name` 表及字体校验和以外的全部表逐字节相同，原字符覆盖 896、902、101 个码点不变。CSS 别名分别为 `AtlasCJK`、`AtlasNarrow`。完整许可见 [Source Han Sans OFL](assets/licenses/SourceHanSans-OFL.txt) 和 [Oswald OFL](assets/licenses/Oswald-OFL.txt)；原始/输出文件哈希、名称与许可来源见 [派生记录](assets/ofl-fonts.json)。这些派生字体继续采用 OFL，不纳入项目 MIT。制作步骤和保留现有字形的原因见 [字体维护](docs/ASSET_LICENSING.md#开放字体的维护)。
