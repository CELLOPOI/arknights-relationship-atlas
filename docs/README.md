# 文档索引

从本地开发开始，按功能查阅数据规范和实现说明。验证说明记录检查方法与适用边界。

## 开发入口

| 要做的事 | 文档 |
| --- | --- |
| 安装、启动本地应用和执行分层检查 | [开发指南](DEVELOPMENT.md) |
| 了解分支、PR 与 CI | [贡献指南](../CONTRIBUTING.md)、[项目管理](PROJECT_MANAGEMENT.md) |
| 判断哪些文件应提交 | [仓库文件约定](REPOSITORY_POLICY.md) |
| 校验和更新固定素材 | [素材说明](RESOURCE_PACK.md)、[素材与字体记录](ASSET_LICENSING.md)、[第三方来源](../THIRD_PARTY.md) |
| 查看验证和资料工具 | [工具索引](../scripts/README.md) |

## 功能与数据参考

| 范围 | 文档 |
| --- | --- |
| 功能、来源和实现边界 | [当前实现](CURRENT_IMPLEMENTATION.md) |
| 初始化格式与单向快照 | [资料基线](DATA_SOURCE.md)、[资料发布](DATA_RELEASES.md) |
| 修订、审核、预览、发布和资料回退 | [后台工作流](EDITORIAL_WORKFLOW.md)、[候选修订](DATA_CANDIDATES.md) |
| 匿名反馈与访客界面 | [反馈](FEEDBACK.md)、[访客界面](VISITOR_UI.md) |
| NPC、阵营和来源名称 | [NPC 接入](NPC_IMPORT.md)、[阵营](FACTION_UPDATE.md)、[来源名称](SOURCE_TITLES.md) |
| 图谱和游戏 | [关系分组](RELATION_GROUPS.md)、[图谱动效](GRAPH_MOTION.md)、[图谱生命周期](GRAPH_LIFECYCLE.md)、[游戏](GAME.md) |
| 「喜好」分区：人物与皮肤 | [实现](PREFERENCES.md)、[V2验收](PREFERENCES_V2_ACCEPTANCE.md)、[算法与模拟](PREFERENCES_STATISTICS.md)、[接口](PREFERENCES_API.md)、[固定素材](PREFERENCES_ASSETS.md)、[策划](POPULARITY_PROPOSAL.md)、[需求](POPULARITY_REQUIREMENTS.md)、[计划](POPULARITY_DEVELOPMENT_PLAN.md) |
| 设计与工程取舍 | [设计记录](../DESIGN.md)、[参考学习](SOURCE_LEARNING.md)、[决策笔记](../.agents/notes/) |

## 验证契约

[后台验收](EDITORIAL_VALIDATION.md)和[资料写入验证](LIVE_RELEASE_VALIDATION.md)说明隔离数据库与真实浏览器的检查要求；日常命令统一见[开发指南](DEVELOPMENT.md)。

完整截图、日志和数据库附件不随克隆提供，复验须从明确提交重新执行检查。决策笔记的 `proposed` 与 `implemented` 分别表示提案和实现边界，未验证事项不得标为完成。

喜好后续提案：[人物合并与异格独立人气](PREFERENCES_IDENTITY_PROPOSAL.md)，说明双榜计票、同人去重与历史票处理；尚未启用。
