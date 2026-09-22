# 正式资料基线与编译

`data/source/` 保存经数据库导出与上游快照逐项核对的初始化基线，也定义已发布资料的归档格式。日常正式资料已改由[后台修订](EDITORIAL_WORKFLOW.md)审核发布；导出是从已发布版本到 Git 的单向归档，不反向覆盖数据库。首次初始化与既有业务库切换需要分别验证。

2026-09-20 首次核对覆盖 28 个阵营、565 位人物、396 条身份映射、5,711 条关系与 5,711 条证据，逐字段差异为零。人物公开状态、关系公开状态、头像来源、知晓方向及身份标签均在比较范围内。数据库导出不包含条件叙事或上游审读记录，这两类内容从原始快照逐项保留。

## 格式

`manifest.json` 记录 schema 版本、正式资料导出摘要、原始快照各文件 SHA-256、审读版本与差异核对摘要。原始 `data/npc/` 包继续保留，不能用重新生成上游资料代替人工维护后的正式文件。

| 目录 | 内容及稳定标识 |
| --- | --- |
| `factions/` | 阵营 `id`、名称和排序 |
| `people/` | 人物 `id`、姓名、别名、阵营/小队、干员标记、头像元数据及 `published` |
| `identities/` | `external_id` 到 `person_id` 的映射、形态标签及 `published` |
| `relationships/` | 原始关系 `id`、有序人物对、判定、知晓方、说明、稳定键及 `published` |
| `evidence/` | 独立证据 `id`、关系引用、原文、多个带版本/行号的来源及 `published` |
| `conditional/` | 12 组条件叙事及其审读信息，与实际图谱隔离 |
| `provenance/` | 按关系保存的上游审读贡献，保留原文引用、来源、方向与时间范围 |

记录文件名为 `record-<稳定标识的完整 SHA-256>.json`。标识本身保存在内容中，读取时核对文件名；这同时避开关系 ID 中的竖线、大小写碰撞和 Windows 保留文件名。人物姓名不作为文件名，改名不会导致资料重命名。所有业务字段使用显式白名单；原始证据不自动拆句、改写或根据上游贡献重新判定。

旧导入证据的稳定标识为 `import:<原始导入键>`；没有导入键的独立后台证据使用 `database:<首次导出时主键>`，首次受控发布将该标识绑定到 `Evidence.source_id`，之后不按新数据库的自增值重新生成。新增候选证据采用独立生成的稳定标识。关系文件只引用人物，证据文件引用关系，因此同一关系可以拥有多个独立证据文件。

迁移为旧身份映射和旧证据补充 `published: true`，保留原本可用的语义，并未批量撤下或重新判定资料。`published: false` 表示保留记录与引用但不公开。编译出的图谱过滤未公开人物及其关联边，同时尊重关系自身公开状态。身份映射和证据的公开读取也尊重各自状态。文件缺失不能解释为撤下；发布器会在应用前核对并拒绝意外遗漏。条件叙事包括假设结局和作品内电影两种范围，保留贡献记录，不编译成实际关系。

## 命令

从根目录导出现有数据库。此命令使用 PostgreSQL 的只读可重复读事务，只查询正式资料白名单；先按部署文档完成整库备份，再执行：

```bash
DATABASE_URL='postgresql://user@127.0.0.1:5432/atlas' backend/.venv/bin/python backend/manage.py export_formal_data --output .runtime/baseline-export --snapshot data/npc
```

输出为 `formal-data.json`、逐字段 `differences.json` 和 `summary.json`。既有输出目录会拒绝覆盖。发现差异时核对是否为应保留的后台修改，不能以旧快照覆盖数据库。

首次建立新目录时使用已审查的数据库导出：

```bash
backend/.venv/bin/python backend/manage.py bootstrap_source --export .runtime/baseline-export/formal-data.json --snapshot data/npc --output .runtime/source-candidate
```

存在差异时命令默认拒绝，并提供差异摘要；核对导出报告后可以用 `--reviewed-differences-digest` 明确绑定已审查差异，结果保留数据库正式字段。该选项只用于首次迁移，不是日常资料更新或绕过资料 PR 的入口。现有资料目录同样拒绝覆盖。

校验和编译不访问数据库，也不需要相邻剧情工程：

```bash
backend/.venv/bin/python backend/manage.py compile_source --source data/source --output .runtime/data-build
```

不传 `--output` 时只校验并输出摘要。输出目录包含完整 `data.json`、公开 `graph.json` 和文件清单/摘要/计数 `manifest.json`。完整 `data.json` 保留未公开资料，不能直接作为公共静态文件托管；`graph.json` 才执行公开状态过滤。编译清单中的每个文件摘要由解析后的规范化 JSON 计算；缩进或对象键顺序变化不会改变该摘要。`source_digest` 对文件摘要清单计算，`data_digest` 对完整规范资料计算，`graph_digest` 对公开图谱计算。原始快照在来源元数据中的 SHA-256 仍按原始文件字节计算，两种用途不能混淆。编译不写入构建时间或本机绝对路径，相同内容的输出可逐字节比较。

校验覆盖重复 JSON 键、非有限数字、未知字段、数据类型、引用、重复人物对、知晓方向、无证据关系、来源版本与行号、条件范围、文件名及符号链接。阵营名称、图谱范围和计数由编译器派生。字段或语义规则需要扩展时，修改 schema、校验和相应测试，不手改生成图谱中的派生字段。

测试位于 `backend/atlas/test_source_data.py`，随 `make check` 和 `make check-postgres` 执行。完整旧包往返测试验证首次转换不改变资料语义；当前正式资料另行校验和重复编译，后续正常资料 PR 不必保持与旧快照相同。测试使用独立内存库或专用 PostgreSQL 测试库，不读写网站数据库。
