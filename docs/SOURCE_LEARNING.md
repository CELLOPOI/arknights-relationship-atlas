# 参考来源与适配边界

界面参考 `arknights-rebuild` 的官网模块与粒子实验。参考工程只用于来源追踪，不属于本项目日常构建依赖。下列机制记录区分参考实现与本项目适配，不将参考代码或游戏内容纳入原创代码 MIT 范围；版权和许可状态见[第三方来源](../THIRD_PARTY.md)。

保留黑白与青色强调、字体层级、方向性转场和粒子机制。图谱布局、历史恢复、证据语义及 Vue 页面职责见[当前实现](CURRENT_IMPLEMENTATION.md)和[设计记录](../DESIGN.md)。

## 喜好分区的前端参考

「方舟关系与喜好」新增喜好功能时，继续以用户指定的本地 `arknights-rebuild` 工程作为前端参考资料。开始界面实现前，先读该工程的 `README.md`、`src/README.md` 与 `docs/SOURCE_LEARNING.md`，再按下面的模块入口核对源码；已有桌面、手机截图可以辅助理解构图，但要检查是否对应当前源码。

重点学习导航与字体层级、人物立绘构图、画廊排列、选中反馈、方向性转场，以及桌面/手机布局的处理方式。将适用部分融入本项目现有 Vue 组件和样式体系；参考工程保持只读，日常运行与构建不依赖其目录。

参考用途按界面区分：共享页面、导航与整体视觉学习 `arknights-rebuild`；人物两两比较沿用本项目游戏的双人物布局；皮肤列表遵循用户给定的游戏干员界面构图。已确定的「喜好」同页左侧「人物 / 皮肤」切换、右侧职业筛选、卡片仅立绘与名字等需求优先。完整交互与验收见[喜好开发需求](POPULARITY_REQUIREMENTS.md)，不因参考工程原有轮播或分区结构改变投票流程。

## 机制来源

- 分区转场与滚轮/触摸锁：参考 `src/chunks/homepage/modules/Sections.js` 的纵向手势、方向与转场期间锁定。首页与阵营以 600ms 的前后画面纵向移动衔接，共享粒子画布通过变换过渡；游戏跨入口使用 View Transition 快照，保留独立应用生命周期。图谱入口保留 `clip-path` 揭幕，人物连续探索使用较短、可取消的过渡。不移植整站 webpack 运行时或 anime.js，交互边界见[分区决定](../.agents/notes/implemented/architecture/2026-09-17-sections-and-faction-particles.md)。
- 立绘构图、轮播与页面生命周期：参考 `SectionCharClient.js`、`SectionInfoClient.js`、`SectionWorldClient.js`、`SectionMediaClient.js`、`SectionMoreClient.js`。关系探索采用手动选择，人物预览保留平滑跟随，不采用 RGB 形变。
- 导航与字体层级：参考 `src/chunks/layout/modules/Layout.js`、`src/styles/144c734e19afaa20.css` 和 `src/styles/6aed155137c3fe93.css`。当前令牌与加载位置以[设计记录](../DESIGN.md)为准。
- 粒子采样、弹簧、阻尼和局部扰动：由参考 `experiments/terra-particles/particles.js` 迁入后适配，当前模块位于 `frontend/src/atlas/particles.js`；屏外结构路径由 `emblem-motion.js` 管理。生命周期、减弱动态和 Canvas 回退约束见[分区与粒子决定](../.agents/notes/implemented/architecture/2026-09-17-sections-and-faction-particles.md)。

徽记、立绘与字体的原始及派生来源、摘要和许可链接由 `assets/` 清单维护，构建使用[固定素材](RESOURCE_PACK.md)。开放字体子集使用 AtlasCJK / AtlasNarrow 别名，改名及版权要求见[字体维护](ASSET_LICENSING.md#开放字体的维护)。相关美术、字体与商标归原权利人，来源追踪不等于公开再分发授权。

喜好界面已将参考机制适配到 Vue：共享黑白字体层级和青色当前态；左侧纵向视图按钮与右侧独立职业面板；稳定随机候选顺序、缩略目录与全幅详情分层；跨入口沿用现有 View Transition，同页保留组件草稿与滚动状态。正式比较使用独立纯展示组件，隔离游戏换阶段与个人外观，手机和低高度横屏保持双列选择及可滚动操作。没有迁入参考工程运行时。

V2再次只读核对参考工程的Layout、Sections、SectionCharClient、SectionMediaClient与样式，并结合本站CharacterIllustration的灰阶背景实现真实半身卡面；适配结果为Vue/CSS与离线裁切。跨入口方向改为统一页面顺序，原生滚轮与触控只在边界接管；普通构建不依赖参考工程。
