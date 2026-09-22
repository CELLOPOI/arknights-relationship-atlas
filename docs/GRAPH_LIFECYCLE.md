# 图谱实例生命周期

WEB-02 将原来在 ES 模块加载时立即执行的图谱与门户，改为由 `AtlasShell.vue` 挂载时调用 `createAtlas(root)`。卸载先执行 `dispose()`，异步 import 尚未完成时也不会在卸载后创建实例。SVG、粒子渲染、分组、分页和历史布局算法保持原实现。

`createAtlas(root)` 返回 `ready`、`update(data)` 和 `dispose()`：`ready` 在首次有效资料可用时完成，加载失败时保留重试，销毁则以 `null` 完成；`update` 接收已声明的 `AtlasData`，先校验人物、阵营、关系 ID、端点和类型，再更新邻接表与界面；`dispose` 可重复调用。新数据会使旧布局缓存失效，并优先于此前启动但尚未返回的初始请求。

同一 DOM 根只允许一个门户实例。实例引用放在根节点的共享 Symbol 上，使 Vite 热更新产生不同模块版本时仍可清理旧实例。仅用模块内 WeakMap 会让两个模块版本同时持有同一根，真实浏览器计数已复现这一情况。不同页面不共享图谱状态；需要离开再返回时，原有浏览历史仍负责恢复布局。

`graph.js` 和 `portal.js` 内的状态都属于工厂实例，资源经 `lifecycle.js` 管理：全局及静态 DOM 监听、属性处理器、ResizeObserver、IntersectionObserver、定时器、requestAnimationFrame、Web Animations 及 JSON 请求。销毁中止请求，并使已经排队的回调失效。动态名录监听另有短生命周期，在切换或关闭档案面板时释放。

`GraphMotion` 与 `ParticleField` 各自提供 `dispose`，释放观察器、全局监听与动画帧。粒子销毁还删除 WebGL buffer、program 和未完成编译的 shader；徽记图片解码可随请求信号取消。公开的 `relationshipAtlas` 与 `terraPortal` 只由所属实例清除，旧实例的销毁不会删除新实例的入口。

数据边界由 `types.ts` 的 `AtlasData`、`AtlasPerson`、`AtlasEdge`、`AtlasFaction` 与 JS JSDoc 连接。`data.js` 校验输入，不静默过滤断开的关系或改写知晓方向。此轮没有把整个图谱改写为 TypeScript，也没有为不变的布局算法增加第二份实现；后续纯逻辑抽离应由实际修改需求推动。

验证命令：

```bash
npm --prefix frontend run test:atlas
npm --prefix frontend run typecheck
npm --prefix frontend run test:game
npm --prefix frontend run build
FRONTEND_URL=http://127.0.0.1:5174 node scripts/verify-atlas-lifecycle.mjs
FRONTEND_URL=http://127.0.0.1:5174 node scripts/verify-feedback-ui.mjs
```

生命周期浏览器脚本需要 Vite 开发服务，以动态加载 Vue 组件执行真实卸载、重新挂载及实例更新。全部 `/api/**` 请求在浏览器内 mock，未写业务数据库。脚本代理浏览器原生事件、观察器、RAF 与 timer 方法进行计数，不读取实现内部的资源列表；定时器按调用栈统计图谱模块，排除 Vue/Vite 开发工具的独立定时器。

本轮验收覆盖四次 Vue 重挂载、同根重复初始化、重复销毁、销毁后异步返回、无效资料拒绝、更新优先于旧请求、搜索、分组分页、阵营筛选、历史返回、触摸点按和平移，以及游戏入口。卸载后图谱观察器、RAF 和定时器均为零，全局监听回到同一基线。反馈的桌面与手机隔离回归也通过。

报告位于 `.runtime/verification/lifecycle/`，不提交运行输出。此结论覆盖 Chromium 自动化与已有游戏单测，不等同于真实手机 GPU、软键盘、长时间内存堆分析或全部浏览器兼容验证；未据此声称性能提升。
