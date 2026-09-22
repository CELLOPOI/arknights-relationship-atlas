# 开发协作与检查

源码仓库为 [CELLOPOI/arknights-relationship-atlas](https://github.com/CELLOPOI/arknights-relationship-atlas)。开发任务通过 [Issues](https://github.com/CELLOPOI/arknights-relationship-atlas/issues)记录问题、范围和验收条件，通过 PR 审查代码、迁移、测试和文档。资料修订遵循[后台工作流](EDITORIAL_WORKFLOW.md)，不以修改 Git 基线覆盖后台维护结果。

## 职责与分支

资料编辑提供可定位的原文和修订依据；开发者维护实现、迁移与测试；审查者核对资料差异、行为变化、兼容性和验证结果。同一人可以兼任，不能将本人检查称为独立复核。`CODEOWNERS` 表达审查归属，本身不授予仓库权限。

从 `main` 创建目的明确的短期分支，例如 `feat/graph-search`、`fix/release-validation`、`docs/development`。PR 遵循仓库模板，说明具体问题、最终行为、迁移或配置影响、实际检查及未验证范围。合并前核对当前提交与检查结果，按实际分支保护处理，不为方便合并关闭保护。

## 验证层次

| 检查 | 覆盖范围 |
| --- | --- |
| `make check` | 隔离 SQLite 后端检查、完整前端构建与测试、工具检查 |
| `make check-frontend` / CI `frontend-source` | 固定素材校验、类型检查、生产构建、游戏与图谱测试 |
| `make check-frontend-source` | 快速类型与算法检查，不代替完整构建 |
| `make check-postgres` / CI `backend-postgres` | 专用 PostgreSQL 上的后端、锁、并发和约束验证；CI 另执行工具检查 |
| 浏览器回归脚本 | 根据交互改动选择，说明模拟 API 或真实隔离数据库的边界 |

CI 保留 `frontend-source` 和 `backend-postgres` 两个检查名称，前者执行完整 `make check-frontend`。CI 使用只读仓库权限和随库固定素材，不需要业务数据库、私有反馈或服务器凭据。新增 Python 工具纳入 `make check-tools` 的静态检查和测试。

SQLite 测试不能替代 PostgreSQL 验证，模拟 API 不能证明真实数据写入，源码合并也不证明任何外部实例已更新。具体运行命令与专用测试库限制见[开发指南](DEVELOPMENT.md)。

版本标签、程序提交、资料版本与素材版本各自表达不同对象；创建标签时记录对应的验证范围。私有反馈与联系方式不得贴入公开 Issues，公开快照仅从已发布资料单向归档。提交范围见[仓库文件约定](REPOSITORY_POLICY.md)。
