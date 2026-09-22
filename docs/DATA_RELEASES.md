# 正式资料发布、预览与回退

日常资料通过 [后台资料修订](EDITORIAL_WORKFLOW.md) 完成编辑、审核、预览及事务发布，数据库中的已发布版本为正式依据。代码仍经 Git PR。Git 资料文件用于首次初始化和单向快照归档；第一次后台发布后，旧资料包预览与应用入口均拒绝覆盖数据库。

## 后台发布

审核通过的修订才能预览发布。服务端校验完整资料、原文证据、方向、头像资源和当前基线；预览令牌绑定修订版本、完整摘要、素材版本、发布账号及关联反馈版本，一小时内有效。

确认发布时重新验证令牌和基线，在统一发布锁与事务内应用所有资料、修订审计、发布记录及反馈结案。失败时一起回滚，公开接口继续读取旧版本。发布 ID 自动生成，正式资料返回当前 `dataRelease`、来源 `origin` 与 ETag；后台发布的 `gitCommit` 为 `null`，不会把旧源码 commit 冒充本次资料来源。

已审核内容不能原地修改，须退回草稿并重新审核。并发编辑、不同修订竞争发布、数据库漂移和过期预览都拒绝覆盖，操作方法见[后台维护](EDITORIAL_WORKFLOW.md)。

## 回退资料

从“资料发布”选择历史版本，创建回退修订、检查差异、审核并发布为新版本。后续新增 ID 保留，可撤下记录明确设为不公开；阵营、条件叙事和来源贡献保留追溯。回退不恢复账号、反馈或整个数据库，既有反馈的处理历史也不自动改判。灾难恢复仍使用独立的备份与恢复流程。

## 导出版本

发布详情可下载确定性的资料 ZIP。正式数据白名单包含撤下记录、独立证据、条件叙事与来源，不含账号、反馈、联系方式、编辑备注或审核记录。可以解压到新的目录后运行 `compile_source`，也可以归档到 Git；导出快照不构成反向发布入口。

## 首次初始化

新库或尚无发布基线的旧库须先备份、迁移，并核对实际正式资料与[初始化基线](DATA_SOURCE.md)。旧库可能含有需要保留的编辑，不能清库重导。以下命令仅用于经过核对的首次初始化：

```bash
backend/.venv/bin/python backend/manage.py build_data_release --source data/source --release-id atlas-data-v1 --asset-version atlas-assets-b17728bb0b140b17fbac1a57 --output .runtime/releases/atlas-data-v1.json
backend/.venv/bin/python backend/manage.py release_data --package .runtime/releases/atlas-data-v1.json --preview .runtime/releases/atlas-data-v1-preview.json
```

核对私有预览后应用：

```bash
backend/.venv/bin/python backend/manage.py release_data --package .runtime/releases/atlas-data-v1.json --apply .runtime/releases/atlas-data-v1-preview.json
```

生产初始化包仍要求干净、已审查的源码，源文件必须与 HEAD 一致，素材版本和公开头像须匹配。`--allow-dirty` 仅供 DEBUG 下隔离演练，生产拒绝。已有初始基线可直接开始后台修订，迁移不改变已有正式记录或自动发布草稿。

首次后台发布将 `ReleaseState.authority` 设为 `database`。不要修改该状态、打开兼容开关、清空发布记录或使用旧导入器绕过保护。

## 代码升级

代码和资料可以分别更新。代码升级需要备份、检查迁移计划、执行迁移、更新服务并验收；保留当前正式资料版本。交付目录内的 `data-release.json` 是初始化输入，已启用后台维护的网站不再次应用它。数据库结构回退需要检查旧代码兼容性，不能用资料回退替代。

本轮的 PostgreSQL、浏览器和隔离数据库验证见 [后台更新验收](EDITORIAL_VALIDATION.md)。既有业务库迁移、公网部署及容器交付须按实际环境单独执行，不能用测试库结果代替。
