# 喜好接口契约

所有地址位于 `/api/preferences/`，字段采用 snake_case。GET 不出题、不计票。公开 `runtime/`、`directory/`、兼容入口 `catalog/`、`rankings/`、`trends/`、`pairs/` 不要求身份。所有私有响应 `Cache-Control: private, no-store`，不公开参与者 ID。

先 GET `runtime/`（同时取得 `csrftoken` Cookie 与当前名录版本），按版本读取 `directory/`，再 POST `identity/` `{}`，写请求发送 `X-CSRFToken` 与同源 Cookie。身份凭证由服务器生成的 HttpOnly、SameSite=Lax Cookie 保存，生产强制 Secure；不接受客户端 visitor ID。identity 返回与 GET `state/` 相同的结构。没有身份的私有接口返回 401 `identity_required`。

GET `runtime/` 返回 `{catalog_version:string|null,config,server_time:string}`，使用 `private, no-store`，每次读取实时开关。GET `directory/?version=<catalog_version>` 只返回 `{catalog:Catalog}`，与访客身份无关，不创建 Cookie；使用 `public, max-age=0, must-revalidate` 和 ETag，条件命中时返回 304。没有已发布名录返回 503；请求版本与当前版本不一致返回 409 `catalog_conflict`，客户端重新读取 runtime 后再请求目录。目录缓存不能绕过维护开关与来源限流；个人状态版本必须与所显示目录一致。前端最多重试三次发布冲突，不用旧目录替代读取失败。其余喜好响应禁止存储，具体实现见[缓存决定](../.agents/notes/implemented/architecture/2026-09-25-image-and-public-cache.md)。

兼容原客户端的 GET `catalog/` 返回 `{catalog: Catalog|null, config: {weekly_limit:300,rolling_limit:1200,person_limit:6,support_limit:15,favorite_limit:3,rest_interval:50,pair_repeat_days:84,cooldown_hours:24,task_hours:24,phase:"trial",writes_enabled:boolean,tasks_enabled:boolean,supports_enabled:boolean,choices_enabled:boolean},server_time:string}`。

Catalog 为 `{version,asset_version,source_version,persons:Person[],forms:Form[],appearances:Appearance[],professions:Profession[],subjects:Subject[], ...coverage}`。Person 为 `{id,name,aliases:string[],kind:"operator"|"npc",eligible:boolean,representative_url,form_ids:string[],form_catalog_version?:string}`。Form 为 `{id,person_id,name,profession,order,default_appearance_id,catalog_version,eligible:boolean,complete:boolean,appearance_ids:string[]}`。Appearance 为 `{id,form_id,name,kind:"base"|"elite"|"outfit",image_url,thumbnail_url,portrait_url,focus:{crop,method,reviewed},eligible:boolean,...provenance}`。Profession 为 `{id,name,icon_url}`。Subject 继承 Person 的显示字段，增加 `{person_id,form_id:string|null}`；id 为 `form:<形态ID>` 或无形态人物的 `person:<人物ID>`，name 与 representative_url 是具体形态的固定题面。六个确认的临时支援实例不重复加入 subjects，原始 forms 保留。候选显示顺序可以由前端用服务器返回的 `choice_order_seed` 加对象/名录版本进行稳定散列排序；不影响统计。

GET `state/` 与 POST `identity/` 返回：

```json
{
  "server_time":"2026-09-23T12:00:00+00:00",
  "catalog_version":"preferences-catalog-v2",
  "risk_status":"accepted",
  "writes_enabled":true,"task_enabled":true,"cooldown_hours":24,
  "choice_order_seed":"opaque-browser-specific-seed",
  "quota":{"weekly_limit":300,"weekly_used":0,"rolling_limit":1200,"rolling_used":0,"remaining":300,"person_limit":6,"rolling_days":28,"weekly_resets_at":"...","rolling_recovers_at":null},
  "pending_task":null,
  "supports":{"support_ids":[],"favorite_ids":[],"legacy_support_ids":[],"legacy_favorite_ids":[],"subject_support_ids":[],"subject_favorite_ids":[],"version":0,"modified_at":null,"next_change_at":null,"risk_status":"accepted","support_limit":15,"favorite_limit":3},
  "choices":[]
}
```

POST `tasks/` `{operation_key:"uuid"}` 派发或恢复；返回 `{task:Task,quota:Quota}`。Task 为 `{id,left:Subject|Person,right:Subject|Person,left_id,right_id,left_subject_id,right_subject_id,catalog_version,issued_at,expires_at,status:"pending"|"answered"|"expired"|"void",outcome:null|"choose"|"skip"|"unfamiliar"|"unfamiliar_left"|"unfamiliar_right"|"unfamiliar_both"|"tie",winner_id:null|string,accepted_at:null|string,risk_status:"accepted"|"pending"|"excluded"}`。POST `tasks/<id>/answer/` `{operation_key,outcome:"choose",winner_id:"person-id"}` 或 `{operation_key,outcome:"skip"|"unfamiliar"|"unfamiliar_left"|"unfamiliar_right"|"unfamiliar_both"|"tie"}`，返回同结构。新任务的 left/right 为实际形态，left_subject_id/right_subject_id 为其带类型 ID；left_id/right_id/winner_id 始终为人物 ID。旧任务的 subject 字段为空，只进入人物视图。一次答案只保存一个原始任务，配额只消耗一次。跳过不计胜负。不要在隐藏的人物视图自动派题。正式接口不接受指定对手或练习记录。

GET `supports/` 返回上述 supports，其中 support_ids/favorite_ids 是形态映射与历史人物登记的去重并集，供显示人物名额；legacy_* 仅历史未指定形态登记，subject_* 为用户选择的带类型对象 ID。

PUT `supports/` `{operation_key,version,subject_support_ids:[...],subject_favorite_ids:[...],legacy_support_ids:[...],legacy_favorite_ids:[...]}` 原子替换名单并记录完整事件。四个列表全部提交，legacy_* 只能保留或移除现有旧登记，不可新增。支持上限按人物并集 15，本命按人物并集 3；每人物最多一个形态本命，且本命属于对应支持子集。形态多选同人只占一个名额，取消最后一个形态自动撤回派生人物支持。旧 `{support_ids,favorite_ids}` 写法仅在还没有形态登记时兼容，已有形态登记则返回 409 client_outdated，避免旧页面覆盖新状态；两种字段集不能混用。同内容不新开冷却。

GET `choices/<kind>/<object_id>/` 返回 Choice，kind=`form` 时 object_id=人物 ID；kind=`skin` 时 object_id=具体形态 ID。未登记 Choice 为 `{version:0,action:"withdraw",choice_id:null,catalog_version:null,confirmed:false,next_change_at:null}`。已登记包含 `{kind,object_id,version,action:"choose"|"none"|"withdraw",choice_id:null|string,catalog_version,confirmed:boolean,available:boolean,modified_at,next_change_at}`。个人全部 Choice 在 state.choices。

PUT 同地址 `{operation_key,version,catalog_version,action:"choose",choice_id:"candidate-id"}`，没有明显偏好用 `action:"none"`，撤回用 `action:"withdraw"`（后二者不含 choice_id）。POST 同地址加 `confirm/` `{operation_key,version,catalog_version}` 确认仍合法的旧选项，即使冷却中也可确认，不重新计票。形态候选版本使用 Person.form_catalog_version（API始终规范化返回；源名录未显式设置时由该人物合格形态ID集合派生稳定摘要），外观候选版本使用 Form.catalog_version。

GET `rankings/?scope=form&kind=random&window=84` 返回 `{scope,kind,window,object_id,snapshot:null|Snapshot,status:"no_data"|"current"|"delayed"}`。kind=`composite` 时 window=84（其余值拒绝），kind=`support` 时 window=0，kind=`form` 或 `skin` 时 window=0 并指定 object_id。scope 为 person / form，省略默认 person；random/support/composite 支持双视图，kind=form/skin 的内部偏好统计仅支持 scope=person。Snapshot 包含 `{id,scope,cutoff,generated_at,catalog_version,algorithm_version,asset_version,revision,reason,payload}`。payload 包含 `{rows:[],sample_size,participant_count,window_start,window_end,actual_days,status,...}`；random rows 包含 `{id,score,interval:[low,high],rank:null|number,comparisons,raw_comparisons,weighted_evidence,effective_participants,participants,opponents,status}`，support rows 包含 `{id,count,favorite_count,share}`，form/skin rows 包含 `{id,count,share}`。份额取0–1。样本不足保留真实量，rank=null，不制造榜位。

GET `trends/?scope=...&kind=...&window=...&object_id=...` 返回 `{snapshots:Snapshot[],changes:{"7":null|{baseline_at,rows:[{id,delta}]},"28":...}}`，最多180个真实快照；趋势按统计视图/名录/算法/素材/参照集合/修订分段；综合指数和支持净变化仅在这些口径可比时提供。随机趋势保留实际节点，不返回7/28天差值。无历史 snapshots=[]，没有可比基线 changes 项为 null。随机榜窗口只支持84或28。

GET `pairs/?scope=...&left_id=...&right_id=...&window=84` 返回 `{scope,left_id,right_id,left_wins,right_wins,sample_size,window,window_start,window_end,status}`，person 视图传人物 ID，form 视图传带类型 Subject ID；仅实际正式判断，不使用模型预测，也不应用榜单的窗口去重和权重。

GET `records/` 返回 `{records:Task[],next_cursor:null|string}`，按受理时间倒序，每页50；可传 `cursor`（服务器时间 ISO）继续。没有记录时空数组，不生成个人完整排名。

错误统一 `{code,detail,...}`：400 参数/归属无效，401 identity_required，409 version_conflict（含 latest）、catalog_conflict（含 catalog_version）、cooldown（含 next_change_at）、quota_exhausted（含 quota）、no_eligible_pair、task_expired、operation_conflict、choices_unavailable，429 rate_limited（含 retry_after），503 writes_paused/catalog_unavailable。CSRF 拒绝为403。operation_key 为8–100字符，每次新动作唯一；失败未知时原内容原键重试。相同键异内容冲突。风险 pending 登记保留个人状态，暂不进入公共统计。

后端管理命令：`preference_catalog draft --actor <staff> --file <catalog.json> --reason <依据>`，随后 `approve --catalog-version <版本> --actor <staff> --reason <审核意见>`，再 `preview --catalog-version <版本> --actor <staff> --preview <新文件>`。阅读差异后 `publish --catalog-version <版本> --actor <staff> --preview <文件>`；预览绑定账号、内容摘要、基线、审核人及运行修订号，1小时有效。后台同样提供审核/预览/确认发布入口。没有初始化脚本自动发布名录。

`aggregate_preferences` 使用同一事务输入截止点、数据库锁和幂等快照。调度每15分钟运行（包含84/28天模型与登记汇总），每日固定时点的快照因此也被保存；调度由部署者配置。失败保持最后成功快照，在运行控制中记录错误类型。`review_preference_risk <私有参与标识> --status accepted|pending|excluded --actor <staff> --reason <依据>` 记录复核并重算可回放历史，新修订保留 supersedes；后台提供同样操作。超出完整明细保留范围的历史快照保留旧版，不宣称精确重算。

`purge_preferences` 每日清理：风险信号30天、任务/幂等回执/被替代变更180天；当前支持、当前选择与必要的最终事件、名录、公开快照持续保留。运行开关在后台“喜好运行开关”，包括总读写、任务、支持、选择及资源故障对象暂停。`PREFERENCES_ENABLED=0` 可独立关闭此功能。所有管理命令应使用真实授权 staff；正式人物资料保护始终保持开启。

匿名身份只绑定当前浏览器Cookie，不承诺一人一票或跨设备恢复。来源使用短期HMAC风险信号，公开接口不返回来源或参与标识。不接入未经服务端验证的人机供应商；高风险数据暂缓并由后台复核。模型使用对称锚点正则化，200次参与标识聚类bootstrap，比较贡献上限敏感性、补样策略敏感性和左右选择比；V2 门槛为30次去重明确判断、20加权证据、30标识、30聚类ESS、15对手、区间宽度不超过30、上限敏感性位移不超过10，加上网络连接、拟合/重采样收敛、非全胜全败，才展示名次。分数是同版本固定参照池的预计胜率，不等于原始对位比例。

`unfamiliar_left` / `unfamiliar_right` / `unfamiliar_both` 分别记录左侧、右侧或双方不熟悉；旧值 `unfamiliar` 等同双方。随机快照额外返回 observed_start（窗口内首条实际记录时间）。历史GET rankings 可加 snapshot_id 查询特定修订，需同时提供原统计视图/榜种/窗口/对象，不能用另一个 scope 读取该快照。趋势按日保留最新节点与同日口径变化，7/28天基线单独查询，不受高频汇总挤占。

`simulate_preferences` 在内存生成带已知偏好强度的合成数据，输出序关系恢复率、分数误差及聚类区间覆盖；不会向任何数据库写入投票。该单次模拟只验证实现可复验，不替代公开试运行和容量测试。

需要在同一截止点主动生成新修订时，执行 `aggregate_preferences --cutoff <带时区ISO时间> --revise --reason <原因>`。普通定时运行不加 revise，保持同截止点幂等。

每次发布全局名录，旧版本全部待答任务原子作废并返还预留额度；已接受答案保留原名录引用。此规则包括仅文字勘误的全局发布。人物形态确认版本独立于全局版本：源名录未指定 form_catalog_version 时按合格形态ID集合派生，并在公开 catalog 响应补齐；名称/文字修改不要求重新确认。显式确认版本不得在任何历史中用于不同候选集合。

支持7/28天变化使用目标日之前24小时内最近快照，缺少该日可比基线则返回null，不能把更早的任意历史差值标成7/28天变化。

已验证 PostgreSQL 16 的 `pg_dump --format=custom` → 独立新库 `pg_restore --exit-on-error` 合成演练；在空缓存下核对支持/本命、皮肤确认、版本、冷却、派发额度、正式答案、幂等回执和统计快照。演练库已清理，验证产物留在忽略的 `.runtime/verification/preferences-backup-restore/`，未使用业务或预览数据。该验证不代表生产备份策略或容量验收。

2026-09-23 V2 验证：后端155项，SQLite跳过12项 PostgreSQL 专属检查；独立 PostgreSQL 全部通过。完整覆盖、四视口真实/模拟接口、模拟参数与升级记录见 [V2 验收](PREFERENCES_V2_ACCEPTANCE.md)，V1 数字保存在[首版归档](PREFERENCES_V1_ACCEPTANCE.md)。

V2 随机 payload 额外保存 `raw_sample_size`、`weighted_evidence`、`effective_participants`、`component_count`、`connected`、`uncertainty_method`、`reference_pool`、`reference_version`、`parameters`。双上限在84/28天各自完整窗口中计算，去重后最新有效明确对位的权重同时进入胜利与比较边。`parameters` 的变化改变算法版本。

composite rows 为 `{id,score,rank,random_score,random_percentile,support_count,support_percentile,comparisons,weighted_evidence,participants,effective_participants,status,weight_sensitivity,sensitivity_rank_range,weight_unstable}`；payload 另有 `formula,weights,normalization,minimum_reference_size,minimum_support_participants,support_participant_count,reference_pool,reference_version,parameters`。资格不足时 score/rank/percentile 可为 null；实测零支持的 count=0 不能与缺失混淆。搜索只过滤这些固定行，不能在客户端重新求百分位。完整定义见[统计说明](PREFERENCES_STATISTICS.md)。

`aggregate_preferences --catalog-version <已发布版本> --cutoff <带时区时间>` 可以保留原候选口径生成新算法历史序列，不覆盖旧快照。`--revise --reason` 仅用于有依据的同口径修订。`stage_preference_people --actor <staff> --file data/preferences/people-supplement.json` 只创建正式资料修订草稿，后续仍走既有后台审核发布。

浏览器未知结果保存原 scope/path/method/body（含 operation_key），sessionStorage 只辅助恢复，不取得服务器身份权威。跨入口返回仍以 HttpOnly Cookie 查询同一参与者，不因重新调用幂等 identity 接口增加人物身份；不可自动重试另一个对象或另派题。

当前双榜使用 `bt-dual-scope-v3-<参数摘要>`。迁移 `0011_preference_identity_scopes` 保留旧支持与票据，旧快照补 person 口径；新形态字段为空的旧票不会进入形态榜。每次聚合分别计算两种视图的 84/28 天模型、支持及综合榜，同一回答的人物视图先映射双方再去重/封顶。旧算法、旧快照继续保存，跨算法不连趋势。规则与验证见[双口径方案](PREFERENCES_IDENTITY_PROPOSAL.md)。
