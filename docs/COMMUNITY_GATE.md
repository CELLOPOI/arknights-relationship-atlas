# 首版社区开关（API-01）

`COMMUNITY_ENABLED` 默认值为 `0`，开发与生产一致。关闭时，已有会话、普通账号和管理员账号都不能通过旧社区 API 读写数据；已有账号及社区记录保留，不执行删除或结构迁移。管理员继续使用 Django `/admin/` 的独立认证与权限。

| 路由 | 社区关闭时行为 |
| --- | --- |
| `/api/graph/`、`/api/people/<id>/`、`/api/relationships/<id>/` | 保持公开资料读取，包括关系证据、原文与来源；仍遵循资料公开状态 |
| `/api/session/` | 保留当前会话查询及 CSRF cookie，增加 `communityEnabled`；`registrationEnabled` 表示实际是否允许注册 |
| `POST /api/auth/logout/` | 保留退出，仍要求 CSRF 校验 |
| `/api/auth/` 下的登录、注册、验证、重发验证、找回和重置密码 | 拒绝；未完成的旧验证链接不会激活账号，也不发送账号邮件 |
| `/api/favorites/`、`/api/comments/`、评论删除及举报、`/api/submissions/` | 拒绝所有方法，包括历史记录读取；不新增、删除或改写记录 |
| `/admin/` | 不受社区开关控制，沿用后台登录和权限 |

关闭的旧 API 返回 HTTP 403，JSON 为 `{"detail":"账号社区暂未开放。","code":"community_disabled"}`。CSRF 或认证阶段已经拒绝的请求可能先返回对应的 403；前端应以 session 能力字段控制入口，并处理服务端拒绝。前端隐藏入口不能代替这些服务端检查。未知账号 action 在社区关闭时也返回上述拒绝。

`REGISTRATION_ENABLED` 同样默认 `0`。只有两个开关均为 `1` 时注册才开放。显式开启社区总开关恢复旧社区及账号功能，仍受登录、资源可见性、所有权、CSRF、限流与独立注册开关约束。生产示例见 [环境变量示例](../.env.example)，Compose 已通过 `env_file` 传入开关，无需新增 Compose 配置。

匿名反馈已使用独立 API 和权限，不继承 `CommunityAPIView`，也不复用旧投稿入口，见 [反馈流程](FEEDBACK.md)与 [访客界面](VISITOR_UI.md)。正式资料的后台权限另由受控发布与候选编辑管理。

回归测试位于 `backend/atlas/test_community.py`；旧功能测试在 `backend/atlas/tests.py` 中显式开启两个开关。测试核实默认关闭配置、不同身份的旧 API 拒绝及记录不变、禁用账号邮件与激活/重置、公开详情和证据可读、后台登录独立，以及可查询会话和带 CSRF 的退出。
