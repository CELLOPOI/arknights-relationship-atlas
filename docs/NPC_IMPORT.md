# NPC 接入记录

2026-09-20 已将重点 NPC 的复核结果与头像导入本地 PostgreSQL 开发库。完整模式为565人、5,711条关系（4,266对确认相识、1,445对单向知晓）；干员版为396人、3,703条关系。查看 [完整目录](http://127.0.0.1:5173/?scope=all#factions) 或 [博士关系图](http://127.0.0.1:5173/?scope=all&person=npc_b99957887950ebfd#graph)。

## 来源与合并边界

174名重点人物中，Sharp、Pith、Touch、Stormeye、Misery 已有网站身份，复用既有 ID；其余169名作为 NPC 新增。数据读取相邻 `ArknightsNpcCatalog` 的重点名单、八组复核的实际叙事贡献、独立 `act15d0` 审读批次，以及人工复核目录保存的39项意见。原目录只读，网站派生文件集中在 `data/npc/`。

生成前核对39项意见的题目指纹、数据集版本及原文文件哈希，缺失、过期或未确定意见直接报错。6项关系意见应用用户选定的方向；3项“同一人物”意见只补入有明确场景和引文的关系；另外3项候选身份确认保留身份结论，不以共同登场推断相识；27项“不成立／不同人”排除对应候选。人工说明与原文分别存储。明确的人物消歧补充及引用范围见 `scripts/npc-review-overrides.json`，生成器要求引用包含于用户复核时给出的上下文。

同一新增人物对按独立支持的知晓方向合并：两个方向都有证据才判双方相识，不推导传递关系。12组电影、假设或其他条件叙事贡献保留在 `conditional.json`，不并入实际叙事图。原始脚本中的人物发言、正文、选项和分支条件转换为可阅读原文；舞台指令不混入正文，原始逐行引文仍保留在 `provenance.json`。本次核对3,848次引文引用，输入及 SHA256 清单位于 `report.json`。

既有396个人物、3,695条关系及其证据逐项保留。新增2,016条关系，其中8条连接已存在的支持干员与其他干员，因此干员版关系数增至3,703。84个人物对与旧关系重合，保留旧判定与证据，新的篇章贡献单独存入 `provenance.json`，不会静默覆盖旧核查。其间6对的新增贡献方向与旧图不同，详见 `report.json.overlaps`：因陀罗／Misery、斯卡蒂／Misery、歌蕾蒂娅／Misery、Mon3tr／Stormeye、电弧／Sharp、Sharp／Pith。若后续要统一修订既有干员关系，应同时核对双方来源后走正式修订流程；此次接入不把新篇章的单向证据视为否定旧篇章的双向证据。

## 头像与资料归类

169张头像均来自目录已关联的 PRTS 游戏立绘，原图下载至忽略目录 `.runtime/npc-originals/`，头像输出至 `dist/avatars/`。按透明区域和头肩位置裁切为256×256 WebP；对10张自动裁切不合适的立绘保存显式裁切范围。已查看全部头像联系表和修正结果。输出合计2,174,820字节，生产构建包含全部169张。

`assets/npc-manifest.json` 保存原图 URL、PRTS 文件页、版本名称、原图／输出 SHA256 及裁切范围。重复处理时若原图哈希变化会报错，需明确核对来源版本。Medic、奥克里、塔佳娜、迪伦、苦根使用目录提供的通用立绘，人物资料显示“此为通用立绘，仅代表角色的大致形象”，并提供来源链接。素材权属沿用原游戏和来源站说明。

NPC 分组由 `scripts/npc-display-config.json` 按已收录资料中的国家或组织维护，包含历史归属，因此界面使用“资料归类”。新增整合运动、卡兹戴尔、汐斯塔入口；普瑞赛斯、宝巫迦、斑弥罗、大鲍勃、“保存者”暂列未归属。缺少经核实徽记的入口沿用既有无标识点云，不拼造官方徽记。

## 重建与导入

以下在网站根目录运行。需要相邻资料工程和已有 Sharp 模块；头像脚本也支持用 `--sharp /绝对路径/sharp` 指定可用模块。构建阶段只准备派生文件；写入数据库前先备份并运行预演。

```bash
node scripts/build-npc-data.mjs
node scripts/prepare-npc-avatars.mjs --sharp ../ArknightsEvidenceReview/node_modules/sharp
DATABASE_URL=postgresql://user@127.0.0.1:55432/atlas backend/.venv/bin/python backend/manage.py migrate
DATABASE_URL=postgresql://user@127.0.0.1:55432/atlas backend/.venv/bin/python backend/manage.py import_graph --data data/npc --dry-run
DATABASE_URL=postgresql://user@127.0.0.1:55432/atlas backend/.venv/bin/python backend/manage.py import_graph --data data/npc
```

已有记录内容不同时，默认导入拒绝覆盖。初始化前须核对差异；后台维护启用后，不使用 `--update-existing` 或旧包覆盖资料，应通过[后台修订](EDITORIAL_WORKFLOW.md)审核发布。Vue 从数据库 API 读取资料，前端构建使用固定素材清单。

## 验证与范围

执行 `make check` 和专用数据库上的 `make check-postgres`，覆盖头像来源、通用标记、范围筛选、输入校验及原有记录保护。上游重建额外检查复核过期拒绝、方向合并、条件贡献隔离和可重复输出，输入要求见[工具说明](../scripts/README.md)。

浏览器使用 `scripts/verify-npc-ui.mjs` 与 `scripts/verify-ui.mjs`，检查别名、直接链接与刷新、关系原文、通用立绘来源、范围切换、新阵营入口及手机布局。数据库须与候选包逐项比较人物、关系和证据，素材摘要须匹配清单；自动化与静态校验不能替代剧情内容复核。
