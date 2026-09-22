# 素材与字体来源

本项目原创代码采用 [MIT](../LICENSE)，第三方图片、字体、商标和剧情引用保留各自权利。当前固定素材已随源码提交，来源与文件摘要见 [素材说明](RESOURCE_PACK.md)及 [第三方记录](../THIRD_PARTY.md)。素材清单的 `rights_status` 仍为 `unreviewed`，本次收录没有改变第三方许可范围。

## 已取得的 Novecento Webfont

当前使用官方 Webfont kit 的原样 WOFF2：`assets/fonts/NovecentoSansWideBold-d9c32120/font.woff2`，39,708 字节，SHA-256 为 `d9c32120abe0a5ea33dca70cb16083efc06671c86a9a1f781641c47a436bebe2`。来源与 [Web Content EULA](https://www.myfonts.com/pages/license-agreement?eula_lang=eula_en&id=eula_2267) 链接保留在包内 `assets/fonts.json`。

该文件未转换或制作子集，CSS 与 HTML 保留 kit 的原始版权 notice。构建保留这些注释，并由 Caddy 的字体响应设置 `Cross-Origin-Resource-Policy: same-origin`。文件版本为 3.001，覆盖 378 个码点；原参考站子集已从现用素材中移除。

字体不适用项目 MIT。个人许可凭证及使用条件应由使用者自行保存，不作为开发配置分发；仓库收录不构成第三方对其他使用者的再许可。

## 开放字体的维护

当前思源黑体 Regular/Bold 子集元数据为 2.004，Oswald Medium 为 3.0，均内嵌 OFL 1.1。对应的上游许可保留名称 `Source`、`Oswald`，不能用新版许可抹去旧版的名称条件。按 [OFL FAQ 的修改与子集规则](https://openfontlicense.org/ofl-faq/)，本项目将派生字体名称改为 `Relationship Atlas CJK`、`Relationship Atlas Narrow`，CSS 别名为 `AtlasCJK`、`AtlasNarrow`，保留原作者版权。此命名不表示原字形由本项目创作。

完整 [思源黑体许可](../assets/licenses/SourceHanSans-OFL.txt)来自 Adobe 2.004R，[Oswald 许可](../assets/licenses/Oswald-OFL.txt)来自作者仓库 3.0；副本只统一为 LF 换行。完整文本既嵌入字体，也随网站放在 `assets/licenses/`。输入与输出哈希、字符覆盖和许可来源集中记录于 [派生清单](../assets/ofl-fonts.json)，包内 `assets/fonts.json` 保留原始参考站子集的来源及摘要。

这些字体无需商店订单。保留版权、完整 OFL 及名称条件后，可按 OFL 在网站使用、修改和随软件再分发；字体本身继续使用 OFL，不能改为 MIT 或单独售卖。此结论只适用于本节三款字体，不扩展到 Bender、Novecento 或游戏图片。

维护者已持有匹配哈希的旧子集时，可从项目根目录复现改名：

```bash
uv run --script scripts/prepare_ofl_fonts.py --source /path/to/reviewed-original-fonts --output .runtime/ofl-fonts-new
```

脚本声明独立的固定版本 FontTools/Brotli 依赖，不改变业务环境。它只接受清单中的三个原始 SHA-256，拒绝符号链接和已有输出目录；只修改名称/许可元数据，保存后核对所有字体表，除 `name` 与 `head` 的校验和字段外必须逐字节一致。未知输入或字形表变化直接失败，不可套用于商业字体。将结果、完整许可及来源记录加入新候选资源目录后，按 [资源包流程](RESOURCE_PACK.md)生成新清单和归档。现用包已经完成此处理，日常构建不需要重复执行脚本。

采用元数据改名而不升级或换成完整字体，是为保留既有页面字形、字符覆盖和排版；代价是继续维护这三个固定子集。决定与验证见 [工程记录](../.agents/notes/implemented/process/2026-09-20-ofl-subset-names.md)。

## Bender Bold

当前文件来自官方站点，来源与摘要记录于包内 `assets/fonts.json`。已有核对未取得与现用 Bold 子集相符的完整修改、转换及再分发依据，保持待核对状态，不用其他字重的资料代替。

## 构建中的声明

`frontend/scripts/prepare-notices.mjs` 根据锁定的实际依赖生成前端许可文件；来源页 `/sources/` 展示来源、原创代码 MIT、字体和依赖声明。构建时保留随素材提供的许可文本，不将第三方文件改标为 MIT。进一步许可核对的当前范围见 [项目约定](../AGENTS.md#当前许可核对范围)。
