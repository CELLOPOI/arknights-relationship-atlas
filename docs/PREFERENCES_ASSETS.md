# 喜好候选与固定素材

当前名录 `preferences-catalog-v2-portrait-fix1` 固定于北京时间 2026-09-23 内容截止点。包含 581 个人物（397 干员身份、184 NPC）、446 个完整来源形态、1,361 个外观，其中命名服饰 517 套。皮肤目录合并六组临时支援重复入口后显示 440 项。425 个多外观形态可登记，21 个单外观形态仅浏览。`assets/preferences-manifest.json` 固定 4,341 个文件、691,534,328 字节，版本 `preferences-assets-89753731e54e41efdd92b30b`；保留首版全部 192 文件及修正前的棘刺卡面，不改旧文件哈希。

## 完整集合与归属

[固定国服元数据](https://github.com/Kengxxiao/ArknightsGameData/tree/bb8f9ac8db143a661577ed6ef5184d3c6e93d1d0/zh_CN/gamedata/excel) 为 2026-09-20 提交，客户端 2.7.71 / 数据 `26-09-18-14-18-57_b6fbbc`。`metadata.json` 冻结人物、服饰、职业补丁、异格归组及完整剧情单元五表摘录与原始 SHA-256。446 形态包括 429 个可获得干员形态、阿米娅两种职业补丁、15 个已实装具名临时招募/支援形态；后者沿用已确认人物身份，不额外分票。14 个通用预备/功能单位无独立身份，明确列在 excluded_forms。

每形态 `coverage.json` 保存期望 ID、实际完整图/缩略图/半身图、归属依据、图源 URL、源 blob/内容哈希、缺项与状态。当前 446 个形态缺项均为零。分母来自元数据，图仓用于核实资源存在，不能倒过来以图仓数量定义完整性。

精一默认图取具体形态阶段映射；阿米娅术师实际初始/精一分别保留，近卫和医疗按 `buildinPatchMap`，服饰归属优先 `tmplId`。无精二不补造精二；同一静态/动态服饰仅一个稳定 skin ID。录武官“照寰瀛”获取日期为 2026-09-25，晚于截止点，单列排除；ID 含 test 但已有明确实装获取方式的服饰不因名称误删。

## 图源与半身构图

完整外观来自 [fexli/ArknightsResource](https://github.com/fexli/ArknightsResource/tree/230ae8586b4140645af68fe121e44d2676b56197/charpack)，固定 charpack 树 `77748e9bd15bf7a166a2d360310ec031347da90c`。逐图验证 Git blob SHA-1、原始 SHA-256、透明边界和尺寸，使用不带 b 后缀的完整 PNG。输出为透明裁边后最长边 1600、WebP 质量 86；缩略图 contain 于 480×600，保留完整构图。

卡面另派生 480×710 透明半身图，OpenCV 仿射裁切，不生成或重绘角色脸。`portrait-focus.json` 保存来源图摘要、源尺寸、候选脸框、以完整派生图像素为坐标的 `[x,y,width,height]` 裁切、方法及实际复核标记；边界外透明填充。`portrait-review.json` 记录本次全量联系表和方法分布。

棘刺基础与精二卡面按完整派生图的实际像素重新定位头肩，修正顶部留白及精二主体偏左。修正版写入 `v2/portrait/thorns-alignment-v1/`，旧图保留；新名录需经过常规审核发布才会成为 API 的当前目录。准备脚本支持重复传入 `--appearance` 只重建指定条目，以及 `--revision` 写入新路径，避免修两张图时重编码全库。

1,361 张均经 22 页联系表检查；816 张保留经检查可用的检测建议，532 张纠正误检/未检/肩胸位置或改用原画坐标，13 张采用机器、动物等特殊构图。修正条目又分批复查，不能把这些记录解读为 1,361 张均手工绘制或统一参数即人工精修。多主体、侧身、倒置和非人形按原画保留，详情始终可看全幅。

准备工具使用 [lbpcascade_animeface 固定模型](https://github.com/nagadomi/lbpcascade_animeface/tree/4433ab1ae1166ea75acfe99eb0f18709dac329a0)，SHA-256 `9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30`；模型只用于离线建议，不进入浏览器或普通构建，自动建议默认未复核。源图哈希改变会失效旧裁切复核。

八职业图标沿用 [Aceship 固定提交](https://github.com/Aceship/Arknight-Images/tree/0b28f9562fcadbd644c6225f8f8aefbb500b4d22/classes) 的原始 PNG。所有游戏、联动及 PRTS 图像仍为 `rights_status=unreviewed`，来源可取得不等于取得再分发授权。

## 逐剧情 NPC

固定剧情分母为 93 单元：18 个主线、54 个完整活动、21 个故事集，包含联动；复刻按原活动去重。89 单元各选 1–3 人，全局去重后 184 NPC。`npc-selection.json` 逐候选保存独立图像、身份、具体入选理由、剧情文件/行号/上下文/固定 blob 与 SHA-256；`npc-coverage.json` 保存全体剧情单元、选中人物、合并干员及缺项。审读覆盖命中发言上下文、人物描述和实际图像，不宣称逐字通读全部长篇剧情。

已实装者沿用正式干员身份，例如可露希尔、保存者/Friston；说书人归于夕，不新建 NPC 票池。月见夜（泡影国）按平行世界明确身份保留独立人物；不凭同名直接合并。Guard 改用可确认的独立人物立绘；加勒斯、依拉虽具名，但所取图片实际为通用整合士兵，已移除。跨剧情重复人物只占一份身份；与干员统一随机池，无 NPC 票权加成。

| 未覆盖单元 | 实际原因 |
| --- | --- |
| 洪炉示岁 | 主要为拍摄的戏中戏；现实可确认者已实装，扮演名不新增真实身份 |
| 乌萨斯的孩子们 | 核心学生已实装，其他具名同学/亲属未同时取得独立具名立绘 |
| 踏寻往昔之风 | 主要人物已实装；村长为泛称，其余未具备稳定身份与独立图源 |
| 灯火序曲 | 加勒斯、依拉只有通用士兵/术师图，不用通用图补位 |

NPC 复用已固定的独立立绘，另新增 64 个图像文件（`npc-artwork.json`）；旧资料缺少的 63 位 NPC 经 `people-supplement.json` 和受控资料修订补录。来源页及版本依据保存在选择清单；NPC 图像及名字不能当作新增关系边的证据。

## 重建与校验

普通构建只读取仓库内 `assets/`、`data/preferences/` 和已有固定资源包，不依赖相邻工程、原图缓存、OpenCV 或在线下载。

```bash
node scripts/verify-preferences-assets.mjs
node scripts/contact-preferences-portraits.mjs
```

校验清单全部文件哈希、尺寸、完整解码、适用透明通道、V1 保留文件、源元数据独立分母、归属、完整集合、实际资源表、NPC 依据与半身复核。联系表输出 `.runtime/verification/preferences-portraits/`，不随构建发布。

只有显式更新上游时才运行准备流程；先保存旧发布版本，使用新名录版本，逐步审读新内容：

```bash
node scripts/prepare-preferences-metadata.mjs --gamedata /path/to/fixed/excel --commit <40位提交> --cutoff '2026-09-23T23:59:59+08:00'
python3 scripts/prepare-preferences-npcs.py --npc-catalog /path/to/fixed/catalog.json --stories /path/to/fixed/story --story-tree /path/to/fixed/story-tree.txt
# 候选提取只形成审读材料；另行核对后维护 npc-selection / npc-coverage。
node scripts/prepare-preferences-npc-assets.mjs
node scripts/prepare-preferences-assets.mjs --catalog-version preferences-catalog-v3
uv sync --project backend --group assets
backend/.venv/bin/python scripts/prepare-preferences-portraits.py --cascade /path/to/verified/lbpcascade_animeface.xml --workers 6
node scripts/contact-preferences-portraits.mjs
# 审查全部新图及异常，维护 focus/review/coverage，重新校验后走名录审核发布。
node scripts/verify-preferences-assets.mjs
```

准备步骤需要显式源输入和下载权限，不能当作开机或日常构建步骤。新裁切未经复核会被校验拒绝。派生与焦点改变均更新素材哈希和名录校验，不能原地替换线上已发布文件。V2 HTTP 资源位于 `/assets/preferences/v2/{full,thumb,portrait,npc}/`；首版 `/assets/preferences/{full,thumb,professions}/` 继续保留。
