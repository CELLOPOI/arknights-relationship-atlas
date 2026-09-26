# 喜好功能：开发、发布与验收

目录与实时状态已拆分，图片和公开响应的缓存边界见[图片交付与公开资料缓存](../.agents/notes/implemented/architecture/2026-09-25-image-and-public-cache.md)。

「方舟关系与喜好」的 `/preferences/` 共用人物与皮肤入口；`tab=characters`、`tab=skins` 切换视图，`tab=skins&form=形态ID` 打开外观详情。前端位于 `frontend/src/preferences/`，业务、审核与统计位于 `backend/atlas/preference_*.py`。V2 实际覆盖 581 个人物（397 位干员、184 位 NPC）、446 个完整形态目录、1,361 个外观；425 个形态可选择，21 个单外观形态仅浏览。

当前实现和本地验收已完成。实际缺项、测试证据、预览与后续边界见 [V2 验收](PREFERENCES_V2_ACCEPTANCE.md)；完整来源见[素材说明](PREFERENCES_ASSETS.md)，算法见[统计说明](PREFERENCES_STATISTICS.md)，字段见[接口契约](PREFERENCES_API.md)。原首版记录单独保存在 [V1 验收归档](PREFERENCES_V1_ACCEPTANCE.md)。没有自动部署线上，也没有以合成流量代替公众试运行。

## 页面行为

人物视图保留正式随机、纯本机练习、厨力支持、本命、个人记录及各分项结果，新增“近期随机好感 + 当前支持”综合榜。明确点击开始才派题，服务器恢复原待答；每 50 次正式回答提示休息，可直接继续，不强制等待或增加额度。切离人物随机视图、卸载入口、请求未决或写暂停时不自动派下一题。正式题固定代表图，不随个人皮肤改变。

正式随机与个人练习支持方向键：`←` 选左边、`→` 选右边、`↑` 难分高下、`↓` 暂不判断并跳过。桌面按钮标注对应按键，比较区显示提示；窄屏（不超过 760px）、无悬停或粗指针设备隐藏整行键盘提示和按钮按键标记，手机横屏也不显示。鼠标与触屏按钮继续可用。不熟悉仍明确区分左边、右边和双方。快捷键只在当前随机比较视图有题目时生效，输入控件、输入法组合、带修饰键的操作和打开的弹窗保留原键盘行为；长按、提交中、换题中、结果未确认和正式写暂停时不提交，也不缓存按键。图片未就绪时禁止选择胜者，仍可主动跳过。正式答案受理后不能改选；难分高下在正式榜不计胜负，在个人练习榜按平局处理。

「我的喜好榜」依据当前浏览器最近 500 条个人练习自动生成，默认「仅干员」，可切换「干员 + NPC」；同一人物的不同形态合并。每对人物取最近一次明确选择或平局，以正则化成对模型形成组内暂定顺序，未连通的比较组分别显示。练习优先连接分组，再穿插新人物与接近的已比较人物；范围同时控制出题与统计，纯干员榜不使用 NPC 对位。读取兼容旧记录，清空练习同步清榜，存储失败保留当前页并提示。算法、记录及小样本边界见[个人榜决定](../.agents/notes/implemented/architecture/2026-09-23-preferences.md#个人喜好榜与参与额度2026-09-25)。

皮肤卡面按八职业分组，只显示真实立绘与姓名，手机两列。卡面采用已复核的半身派生图；未登记时显示该具体形态精一对应基础图，成功保存后显示个人最爱。默认灰阶，hover / focus-visible 恢复彩色；触屏第一次点击直接进入详情，减少动画偏好关闭位移缩放。详情保留完整构图、放大、最多三套临时比较，所有候选加载成功才可确认。矮视口确认栏随内容滚动，避免挡住图片重试。

搜索、职业、草稿、视图及滚动在页面会话中保存，包括跨来源/游戏入口卸载后恢复。服务器状态仍是正式依据；查询、暂选、比较、浏览或恢复默认图均不计票。未知提交结果锁定原路径、原参数、原操作键，显示“重试原登记/原选择/原名单”；不能换对象重放。恢复返回的旧版本不覆盖其他标签页的新登记。

皮肤目录及人物档案的外观入口按已核对的临时支援映射去重，显示 440 项；六组重复为暮落、Sharp、Pith、Touch、Stormeye、郁金香。446 个来源形态、已有登记和旧详情链接继续保留；真正的异格、阿米娅职业形态和领主·Sharp 不合并。此处只修正目录展示，没有把历史投票转给另一个对象。随机题已改为展示具体形态，一份回答分别生成“干员分开”和“人物合并”结果；支持按形态勾选，同一人物合占一个名额，本命同人只留一个形态。旧未指定形态的登记继续保留，不复制给异格。规则见[双口径方案](PREFERENCES_IDENTITY_PROPOSAL.md)。

滑动翻页范围为首页 → 人物关系 → 游戏 → 喜好，喜好页到达底部后停止翻页。来源与版权素材页通过链接进入并正常滚动，不参与滚轮/触控翻页。点击和历史导航仍保留对应转场方向。长列表先正常滚动，到边界后用新手势换页；输入框、弹窗和图谱缩放保留原操作。

## 数据与事务

匿名凭证使用服务器生成的 HttpOnly / SameSite Cookie，生产使用 Secure；CSRF、用途限速、持久幂等回执、唯一约束及 PostgreSQL 事务保护写入。写入按控制行 → 参与者行加锁。全局控制锁简化一致性，但没有经过真实高并发容量验收。

统计聚合仅在读取截止点输入和发布整批快照时持有控制锁，Bradley–Terry 拟合及重采样在事务外执行，计算期间仍可创建身份、派题与投票。发布前核对名录、修订号和明细保留边界；其中任一变化都会丢弃本轮结果并返回 `aggregation_conflict`，由后续任务重新取数。截止点后的新投票进入后续快照，不必等待本轮计算。实现约束与取舍见[聚合锁边界](../.agents/notes/implemented/architecture/2026-09-23-preferences.md#聚合锁边界2026-09-25)。

每周最多 300 道、连续 28 天最多 1,200 道、每人物 28 天最多 6 次展示；新题按无序形态对防重复 84 天，历史无形态任务按原人物对约束。80% 普通随机先选人物再选形态，20% 补覆盖直接选择缺样本的具体形态，再随机选其他人物及其可用形态作为对手；所有形态仍共享人物曝光额度。派发预留，跳过和自然过期占额；名录发布或明确资源故障作废待答并退额。休息间隔 `PREFERENCE_REST_INTERVAL=50` 与统计 `PREFERENCE_WEIGHT_TOTAL_CAP=50` 独立配置。

补覆盖策略为 `coverage-form-v2`，读取同名录、素材、算法和修订的近期 28 天形态快照。先补基础样本缺口，再补区间过宽；同一层内优先让当前参与者评价尚未明确判断过的对象。快照后的新派发、新受理和仍有效待答会临时占用补题预算，防止半小时统计间隔内反复集中派给同一个对象；这些占位不成为统计证据。没有兼容快照或截止点距今达到两个汇总周期时，按形态近 28 天实际曝光补题。细节及调度近似见[统计说明](PREFERENCES_STATISTICS.md#形态补覆盖2026-09-26)。

补题原因、目标形态、快照来源和补题前缺口写入 `coverage_task_issued` 审计事件，与任务创建处于同一事务，沿用任务明细保留周期清理。恢复待答和幂等重试不重复记账。旧 `coverage-v1` 任务保留，`uniform-v1` 及策略对照含义不变，无数据库迁移。

支持、本命、形态和皮肤保留当前状态、对象版本、24 小时冷却与历史事件。候选新增不自动投票；合法旧选项保留个人卡面，查看完整新集合后才能确认。人物稳定 ID 及异格归属不变。风险隔离/恢复生成审计及统计修订，不能直接改人物票数。

## 从首版升级

已有库不能重新导入 Git 基线覆盖后台资料。先备份，在明确可丢弃的恢复库演练；确认代码、固定素材和数据库属于同一环境。本次双榜增加 `0011_preference_identity_scopes`；新装环境执行完整迁移链，已有 V2 库从 `0010` 升级。迁移为旧快照补 `scope=person`，旧任务形态字段留空，旧支持原样保留；不会推断或复制历史形态票。先迁移再启动新版服务，执行一次 `aggregate_preferences` 生成两种视图的新算法快照。

```bash
backend/.venv/bin/python backend/manage.py migrate
node scripts/verify-preferences-assets.mjs
npm --prefix frontend run build
backend/.venv/bin/python backend/manage.py stage_preference_people --actor reviewer --file data/preferences/people-supplement.json
```

`reviewer` 替换为有权限的真实 staff。补录命令只创建既有[后台资料修订](EDITORIAL_WORKFLOW.md)的草稿，跳过已存在记录并拒绝冲突归属；不能绕过提交审核、审核通过、预览与原子发布。随库补录含缺失干员骋风、63 位 NPC 及具体形态身份映射。在首版 565 人物基线上实际新增 64 人物、50 身份映射、零关系边；不同业务基线的差异以预览为准。审核摘要绑定新增头像的喜好素材版本和内容哈希，图像或版本变化后原审核失效。

正式人物资料发布后，再单独发布喜好名录：

```bash
backend/.venv/bin/python backend/manage.py preference_catalog draft --actor reviewer --file data/preferences/catalog.json --reason 'V2 全目录、剧情依据与半身构图已复核'
backend/.venv/bin/python backend/manage.py preference_catalog approve --actor reviewer --catalog-version preferences-catalog-v2-portrait-fix1 --reason '已核对身份归属、完整候选、固定素材与实际缺项'
backend/.venv/bin/python backend/manage.py preference_catalog preview --actor reviewer --catalog-version preferences-catalog-v2-portrait-fix1 --preview .runtime/preferences-v2-preview.json
```

阅读差异后应用同一预览（有效期一小时）：

```bash
backend/.venv/bin/python backend/manage.py preference_catalog publish --actor reviewer --catalog-version preferences-catalog-v2-portrait-fix1 --preview .runtime/preferences-v2-preview.json
backend/.venv/bin/python backend/manage.py aggregate_preferences
```

后台也提供相同步骤；人员较少时可由同一维护者执行，记录实际操作者，不声称独立人工审批。名录及素材升级都必须使用新版本，不能原地替换已发布内容。旧选择、支持、冷却、审计和快照不清空。原始已受理对局保留，在新窗口中仅对仍合格双方的最新明确对位计算新权重。

## 聚合、历史重算与维护

升级到本次异常边界修复需执行迁移 `0012_preference_event_anchor`，仅为明细清理增加索引，不改写票据、名录或快照。已有实例先备份并执行迁移，再启动新版应用；通用迁移命令见上文。

算法版本为 `bt-dual-scope-v4-<参数摘要>`。本次升级无需新增迁移，保留原始选择、额度及历史快照；下一次正常聚合生成新算法结果。每轮分别生成 `scope=person` / `form` 的 84/28 天随机榜、当前支持与综合榜；同人形态偏好和皮肤登记仍单独统计。页面按随机好感、厨力支持、综合榜排列，新会话默认随机好感，已有会话保留选择。正常每 30 分钟聚合，并每日留存节点；调度器与告警由实际部署环境配置。所有榜种超过一小时未成功更新才按时间判为延迟，名录、算法或修订变更仍立即判过期。普通聚合同截止点幂等。明细仍完整时可按原名录重算为新算法序列：

```bash
backend/.venv/bin/python backend/manage.py aggregate_preferences --cutoff 2026-09-23T00:00:00+08:00 --catalog-version preferences-catalog-v1
backend/.venv/bin/python backend/manage.py aggregate_preferences --cutoff 2026-09-23T00:00:00+08:00 --catalog-version preferences-catalog-v2-portrait-fix1 --revise --reason '已核对的历史纠正依据'
```

截止点须根据实际历史选择；不能选未来，也不能超出已保留明细范围。旧算法快照不覆盖；统计视图、算法、参数、名录、素材、参照集合或修订不同均断开趋势。7/28 天变化只取目标日之前 24 小时内同口径基线，缺失则显示暂无。

更新应用镜像不会修改宿主机定时器。使用 systemd 的部署应在现有聚合 timer 的 drop-in 中设置以下内容，重新加载配置并重启 timer；保留既有 service、维护锁和 `Persistent` 设置。每小时的整点和半点开始计算，成功后才更新页面，因此显示的完成时间会晚于触发时刻。

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* *:00/30:00
RandomizedDelaySec=0
AccuracySec=1s
```

聚合命令完成时分别输出实际耗时和进程 CPU 时间，便于区分等待与计算开销。容器默认将 OpenBLAS/OMP/MKL 线程数设为 1；本轮相同输入的窗口复用一次计算，具体约束与合成计时见[性能说明](PREFERENCES_STATISTICS.md#半小时汇总与性能优化2026-09-26)。此次优化保持 V4 算法版本与所有统计参数，不新增迁移。

`aggregate()` 必须在外层业务事务之外调用，避免嵌套事务把控制锁保留到计算结束。计算失败、版本冲突或快照写入失败均保留原有快照；显式 `--revise` 的修订号与整批新快照一起提交，失败时不消耗修订号。此锁边界修复不改变统计算法、参数或数据库结构。取数与发布仍使用控制锁，实际耗时和内存占用需要随业务量监测。

后台运行开关可分别暂停读取、写入、题目、支持、选择及资源故障对象；`PREFERENCES_ENABLED=0` 关闭整个功能。`review_preference_risk` 要求 staff 与具体原因。`purge_preferences` 每日清理 30 天风险信号、180 天任务/幂等回执/被替代事件，同时保留当前状态及必要锚点、名录与公开快照。清 Cookie 或跨设备不能保证恢复同一身份；匿名标识不是独立真人。

清理先在短事务中推进保留边界，再释放控制锁并分批删除；中断后可以重试，保留边界不会回退。后台控制表单拒绝过期修订。浏览器请求超过 20 秒会结束等待，结果未知的写入继续用原幂等键重试；失效题目与撤下图片恢复可操作状态。约束和验证见[清理与异常恢复](../.agents/notes/implemented/architecture/2026-09-23-preferences.md#清理与异常恢复2026-09-25)。

## 复验

```bash
make check
ATLAS_TEST_DATABASE_URL='postgresql://atlas_test:password@127.0.0.1:5432/atlas_check_local' make check-postgres
backend/.venv/bin/python backend/manage.py simulate_preferences --seed 20260923 --participants 600 --bootstrap 200 --output .runtime/preferences-simulation.json
FRONTEND_URL=http://127.0.0.1:5191 node scripts/verify-preferences-ui.mjs
PREFERENCES_DISPOSABLE_PREVIEW=1 FRONTEND_URL=http://127.0.0.1:5191 node scripts/verify-preferences-v2-real.mjs
PREFERENCES_DISPOSABLE_PREVIEW=1 FRONTEND_URL=http://127.0.0.1:5297 node scripts/verify-preferences-identity.mjs
```

两个真实接口脚本实际登记测试选择，只能用于事先明确新建的可丢弃库。双榜脚本要求先在该库配置测试名录并聚合初始快照；可选 `PREFERENCES_LEGACY_FIXTURE=1` 专用于预置的合成旧登记夹具。模拟接口脚本验证失败与并发页面状态，真实接口脚本验证实际入库、真实图片、四视口、触控边界与恢复，二者范围不能混称。日志与截图位于忽略的 `.runtime/`；合成统计报告 `data/preferences/simulation-v2.json` 不包含真实参与者。


2026-09-23 双榜与翻页修正验收：`make check` 通过（后端 169 项，SQLite 跳过 12 项 PostgreSQL 专属检查；类型、生产构建、4,341 项素材与前端/工具回归通过）；独立 PostgreSQL 的 169 项全部通过，含 0010→0011 旧数据保留检查。日志为 `.runtime/verification/preferences-identity/make-check.log` 与 `postgres-check-final.log`。

`verify-preferences-identity.mjs` 在独立 UTF-8 PostgreSQL 预览库通过 1440×900 / 390×844，覆盖真实采集/保存/切榜，并用局部故障响应验证切榜失败清空旧数据、撤下形态可移除；报告与截图位于 `.runtime/verification/preferences-identity-ui/`。旧接口模拟回归四视口通过，产物位于 `.runtime/verification/preferences-identity/compat-ui/`。目录/棘刺与来源页边界手势检查由 `verify-preferences-skin-fixes.mjs` 通过。所有测试写入均为隔离夹具，未迁移业务库或部署线上。
