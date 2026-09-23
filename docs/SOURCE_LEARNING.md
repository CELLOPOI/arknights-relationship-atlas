# 参考来源与适配边界

界面参考 `arknights-rebuild` 的官网模块与粒子实验。参考工程只用于来源追踪，不属于本项目日常构建依赖。下列机制记录区分参考实现与本项目适配，不将参考代码或游戏内容纳入原创代码 MIT 范围；版权和许可状态见[第三方来源](../THIRD_PARTY.md)。

保留黑白与青色强调、字体层级、方向性转场和粒子机制。图谱布局、历史恢复、证据语义及 Vue 页面职责见[当前实现](CURRENT_IMPLEMENTATION.md)和[设计记录](../DESIGN.md)。

## 机制来源

- 分区转场与滚轮/触摸锁：参考 `src/chunks/homepage/modules/Sections.js` 的纵向手势、方向与转场期间锁定。首页与阵营以 600ms 的前后画面纵向移动衔接，共享粒子画布通过变换过渡；游戏跨入口使用 View Transition 快照，保留独立应用生命周期。图谱入口保留 `clip-path` 揭幕，人物连续探索使用较短、可取消的过渡。不移植整站 webpack 运行时或 anime.js，交互边界见[分区决定](../.agents/notes/implemented/architecture/2026-09-17-sections-and-faction-particles.md)。
- 立绘构图、轮播与页面生命周期：参考 `SectionCharClient.js`、`SectionInfoClient.js`、`SectionWorldClient.js`、`SectionMediaClient.js`、`SectionMoreClient.js`。关系探索采用手动选择，人物预览保留平滑跟随，不采用 RGB 形变。
- 导航与字体层级：参考 `src/chunks/layout/modules/Layout.js`、`src/styles/144c734e19afaa20.css` 和 `src/styles/6aed155137c3fe93.css`。当前令牌与加载位置以[设计记录](../DESIGN.md)为准。
- 粒子采样、弹簧、阻尼和局部扰动：由参考 `experiments/terra-particles/particles.js` 迁入后适配，当前模块位于 `frontend/src/atlas/particles.js`；屏外结构路径由 `emblem-motion.js` 管理。生命周期、减弱动态和 Canvas 回退约束见[分区与粒子决定](../.agents/notes/implemented/architecture/2026-09-17-sections-and-faction-particles.md)。

徽记、立绘与字体的原始及派生来源、摘要和许可链接由 `assets/` 清单维护，构建使用[固定素材](RESOURCE_PACK.md)。开放字体子集使用 AtlasCJK / AtlasNarrow 别名，改名及版权要求见[字体维护](ASSET_LICENSING.md#开放字体的维护)。相关美术、字体与商标归原权利人，来源追踪不等于公开再分发授权。
