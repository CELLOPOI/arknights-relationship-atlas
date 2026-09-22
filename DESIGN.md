---
name: "干员关系档案"
description: "沿用参考工程的黑白、青色、字形与方向性转场，连接阵营粒子入口与人物关系查阅。"
colors:
  accent-cyan: "#18d1ff"
  accent-cyan-hover: "#9aebff"
  accent-cyan-dim: "#10262d"
  accent-amber: "#e4bd7c"
  bg-canvas: "#0b0e10"
  bg-topbar: "#080a0b"
  bg-sidebar: "#0a0c0e"
  bg-surface: "#151a1d"
  bg-surface-elevated: "#222b2f"
  bg-panel: "#101517"
  text-primary: "#f5f5f3"
  text-secondary: "#c6cecf"
  text-muted: "#a4b0b3"
  border-subtle: "#293236"
  border-medium: "#414e53"
  entry-paper: "#f1f2ef"
  feedback-error: "#ffb7b7"
typography:
  display:
    fontFamily: "AtlasCJK, \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "52px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: ".04em"
  headline:
    fontFamily: "AtlasCJK, \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "38px"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "AtlasCJK, \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  archive-title:
    fontFamily: "AtlasCJK, \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.4
  archive-body:
    fontFamily: "AtlasCJK, \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    lineHeight: 1.75
  nav-label:
    fontFamily: "AtlasNarrow, sans-serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1.25
  section-number:
    fontFamily: "Bender, sans-serif"
    fontSize: "45px"
    fontWeight: 700
    lineHeight: 1
  wordmark:
    fontFamily: "Novecento, sans-serif"
    fontSize: "min(17vw, 240px)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-.04em"
  data-label:
    fontFamily: "ui-monospace, \"Cascadia Code\", Consolas, monospace"
    fontSize: "11px"
rounded:
  field: "0"
  toggle: "8px"
  toggle-knob: "50%"
spacing:
  row-gap: "12px"
  panel-inline: "28px"
  mobile-inline: "20px"
components:
  portal-enter:
    backgroundColor: "{colors.entry-paper}"
    textColor: "{colors.bg-topbar}"
    padding: "14px 24px"
  portal-enter-hover:
    backgroundColor: "{colors.accent-cyan}"
  graph-action:
    backgroundColor: "{colors.accent-cyan-dim}"
    textColor: "{colors.accent-cyan}"
    padding: "0 10px"
  search-field:
    textColor: "{colors.text-primary}"
    rounded: "{rounded.field}"
    padding: "6px 0"
    width: "100%"
  site-navigation:
    textColor: "#fff"
    typography: "{typography.nav-label}"
  relation-tab:
    textColor: "{colors.text-muted}"
    padding: "8px 0"
  archive-primary:
    backgroundColor: "{colors.entry-paper}"
    textColor: "{colors.bg-topbar}"
    rounded: "{rounded.field}"
    padding: "11px 18px"
  archive-primary-hover:
    backgroundColor: "{colors.accent-cyan}"
    textColor: "{colors.bg-topbar}"
  archive-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.field}"
    padding: "11px 18px"
  archive-field:
    backgroundColor: "{colors.bg-canvas}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.field}"
    padding: "12px"
    width: "100%"
  archive-feedback:
    textColor: "{colors.accent-cyan-hover}"
    padding: "12px 0"
  archive-feedback-error:
    textColor: "{colors.feedback-error}"
    padding: "12px 0"
  faction-entry:
    textColor: "#dadcdb"
    padding: "12px 0"
---

# Design System: 干员关系档案

## Overview

**Creative North Star: "遵循参考工程的明日方舟视觉"**

视觉权威来自用户指定的只读参考工程 `arknights-rebuild`。沿用黑白底色、青色当前态、实际本地字体、非对称粒子构图与细线目录；描述只归纳当前实现，不另造视觉主题。

首页与阵营入口以画面体验为主（Experience），关系图以查询和操作为主（Operate）。两者共享字形、颜色和方向性动效，关系图保留足够的工具与文字密度。

“联动”使用彩虹小队的原有粒子效果，点击后在同一目录区域展示四支小队。二级目录沿用阵营条目的字体、人数、细线与青色状态，标题旁加返回入口；此时隐藏左右徽记切换按钮，保持当前层级清晰。桌面和手机均保留相同的进入、返回路径。

**Key Characteristics:**

- 黑白层次与青色状态指示。
- 大粒子徽记、非对称留白与细线目录。
- 英文窄体导航、中文粗标题、小号资料标签。
- 方向性揭幕；连续查阅使用更短转场。

本文件记录当前项目的适配结果。参考源码事实与适配判断分别见 [SOURCE_LEARNING.md](docs/SOURCE_LEARNING.md)，产品边界见 [PRODUCT.md](PRODUCT.md)。令牌取自 [site.css](frontend/src/styles/site.css) 与 [graph.css](frontend/src/styles/graph.css)。当前 Vue 构建入口 [main.ts](frontend/src/main.ts) 依次加载 `graph.css`、`site.css` 和 [community.css](frontend/src/styles/community.css)；以下社区条目取自后者与账号、人物／关系组件，仅扩展对应表面。

## Colors

### Primary

青色 accent-cyan 用于当前导航、选中阵营、图节点焦点和操作入口；accent-cyan-dim 承接图谱按钮、列表选中背景，accent-cyan-hover 为已定义的浅青变量。不要仅因为变量存在就为组件增设状态。

### Secondary

琥珀色 accent-amber 只表达单向知晓的关系语义。它不承担主导航或装饰强调。

### Neutral

bg-canvas、bg-topbar、bg-sidebar、bg-surface、bg-panel 以很小的亮度差区分画布、栏位与面板。text-primary、text-secondary、text-muted 区分标题、正文与辅助资料；border-subtle 和 border-medium 用于细线。浅色 entry-paper 用于首页入口与社区表单主动作，形成局部明暗反转。社区成功／状态反馈复用浅青色；feedback-error 仅用于错误文字，并结合明确消息与 alert 语义，不改变关系判定配色。

粒子另有材质着色：WebGL 在 vec3(0.89, 0.96, 0.93) 与 vec3(0.40, 0.78, 0.74) 间混合，Canvas 回退使用 #dcf0e9 与 #85c9bb。这些是渲染实现值，不属于导航调色板。sidecar 的 tonalRamp 是供面板预览的合成 OKLCH 明度序列，不是页面新增令牌。

## Typography

AtlasCJK 承担中文标题与正文；AtlasNarrow 承担英文导航；Bender 承担编号；Novecento 承担英文标记及背景大字。四组字体均由本地 @font-face 加载，文件来源见 [字体来源](docs/ASSET_LICENSING.md)。资料编号沿用系统等宽字体。

前置令牌记录桌面角色。首页标题在 1100px 以下缩至 44px，在 760px 以下为 33px；阵营页标题在手机为 26px。图谱标题独立采用 36px，手机 28px，低高度横屏 24px。辅助功能文字通常为 11–13px；装饰性英文标记可更小。当前字号按各角色定义，没有统一等比比例。不得将图谱的密集信息字号扩散到首页主标题。

社区标题与正文使用 archive-title、archive-body 角色；手机标题缩为 22px，账号身份名为 22px，原文引文为 15px／1.9，资料小标题为 16px，提示与状态通常为 12–13px、评论时间为 11px。这些角色沿用本地中文字体，不改变旧页面字号。

## Layout

桌面顶栏高 80px、左右内边距 40px。首页主文案位于左侧 5%，粒子舞台右侧留 80px、宽 72%；右侧章节标尺宽 80px。阵营页左侧粒子、右侧目录，目录宽 34%，顶部 8%、底部 12%，列表内部滚动。

图谱页另有 64px 工具栏，侧栏宽 216px，1200px 以下缩至 184px。剩余高度分配给标题、横向头像条、可缩放 SVG 和底部操作栏；点位距离不表达关系强弱。

响应条件来自实际媒体查询：1200px 调整图谱密度；1100px 调整门户比例；760px 改为手机导航，顶栏高 68px，阵营上下布局，目录从高度 51% 开始；图谱侧栏改为横向阵营栏。横屏且高度不超过 560px 时，顶栏高 54px，阵营粒子占上方 56%，文字从 56% 开始；图谱隐藏头像条，单阵营总览用横向网格并减少 fit 留白。这些是当前实现条件，不承诺覆盖所有设备比例。

布局检查覆盖桌面、手机与低高度横屏，运行入口见[开发指南](docs/DEVELOPMENT.md)。设备模拟与触摸自动化不能替代真实手机 GPU 或跨浏览器兼容验证。

社区账号弹层居中、宽 480px、最高 90dvh，桌面最大宽度为视口减 32px；档案抽屉在桌面右侧、宽 520px、高 100dvh。760px 以下档案改为底部全宽 90dvh，账号最大宽度为视口减 24px。标题区不收缩，正文独立滚动；标题区内边距桌面 24px 28px、手机 14px 20px，正文桌面 24px 28px 32px、手机 20px 20px，底部取 24px 与安全区较大值。人物信息允许收缩和长文换行，旁侧“查看关系图”动作保持完整单行。

## Elevation & Depth

界面没有 box-shadow 词汇。深度通过暗色面板、细线、层叠和遮罩建立；旧图谱详情 dialog 的遮罩为 rgb(0 0 0 / .48)，新增账号与档案 dialog 为 rgb(0 0 0 / 60%)。两类容器分别记录，不统一改写旧参数。人物悬浮预览采用浅底深字，不增加发光或玻璃模糊。粒子内部的透明度与透视属于画面材质，不扩展成控件阴影。

## Shapes

文字入口、目录与面板使用直线边界，输入框圆角为零。圆形留给图谱头像、轨道和开关旋钮；开关轨道圆角由前置令牌规定。通用控件焦点为青色 2px 轮廓，向外偏移 3px；图节点以青色描边加粗表达焦点。图谱连线通常为 1px，命中区域另扩大为透明 16px 描边。

## Components

首页入口为浅底深字矩形，桌面最小高度 70px，手机 62px；悬停变青色，右上箭头沿方向移动。图谱主操作采用暗青底和青色文字，其余操作透明底，悬停提高背景亮度。旧图谱 disabled 按钮透明度为 .35；社区 dialog 内按钮为 .5。

搜索输入以底线组织，聚焦时底线变青；全局搜索不受当前阵营限制。名录搜索为有边框的 44px 高输入框。导航以英文主行和中文辅行组成，当前页与悬停项使用青色；待定位置保持静态文字。关系名录页签采用底部细线，当前项为青色并有 2px 下划线。

阵营目录是细线分隔的横排文字入口，桌面最小行高 63px，手机 58px、低高度横屏 52px。头像快捷条横向滚动并吸附，选中时恢复饱和度与青色底线；原始头像按实际尺寸裁切，不冒充完整立绘。

关系图为原生 SVG：阵营入口默认限定该阵营，人物入口显示全部跨阵营关系。圆形人物节点和分组节点沿用暗底细线，缩小视图时隐藏部分姓名。旧图谱原文详情为原生 dialog：桌面右侧 448px 宽，手机底部宽 100%、高 min(90dvh, 860px)。顶栏保持固定，正文内部滚动；仅初次打开整个弹层时播放入场动画，内部切换内容不重播。

动效以 [portal.js](frontend/src/atlas/portal.js)、[graph.js](frontend/src/atlas/graph.js)、[particles.js](frontend/src/atlas/particles.js) 为准：页面按前进或返回方向揭幕，横向视口 1000ms、竖向视口 600ms；人物连续探索 260ms，760px 以下 180ms；弹层进入 240ms、退出 180ms。粒子沿徽记结构从画布外飞入，详见[当前实现](docs/CURRENT_IMPLEMENTATION.md)；离开门户或页面不可见时停帧；系统减弱动态时显示静态点阵并取消页面转场。具体缓动与响应条件以对应模块为准。

### 社区弹层、表单与动作

账号、人物和关系档案使用原生 dialog，沿用暗底直角、细线分隔和可见键盘焦点。标题及 44px 关闭按钮位于不滚动的头部，关闭图标为 22px 内联 SVG。正文容纳收藏、讨论、资料和补充页签，页签以青色文字和 2px 底线表示当前项，默认间距 22px、手机 20px，纵向内边距 12px。社区没有另加弹层入场动画。

主按钮使用前置 archive-primary 令牌，最小高度 44px、内容间距 10px、1px 同色边框；悬停变青。次按钮为透明底、灰色细线，悬停及已收藏态使用青色文字和边框；收藏按钮占满正文宽度，并提供 aria-pressed。文字动作最小高 36px，悬停浅青并加下划线。社区按钮颜色转换为 160ms，减弱动态时取消转换；不向旧图谱按钮传播这些尺寸和状态参数。

表单垂直间距 22px，字段标签与输入间距 9px。输入使用前置 archive-field 令牌，1px 细线、零圆角、青色插入符，焦点使用既有 2px 青色外轮廓并偏移 3px。多行输入允许纵向调整，最小高 80px、最高 45dvh；占位符与说明为辅助灰，错误以表单反馈表达，不虚构未实现的字段红框。

### 社区列表与反馈

收藏与提交记录按行分隔，行内边距 18px 0；评论内边距 22px 0，保留原始换行，并允许长文本折行。提交状态、错误及成功反馈采用上下细线和文字，不增加通知卡片：反馈下间距 20px；错误使用 alert，成功与加载使用 status。空态用辅助灰、24px 纵向留白和 1.9 行高。原文来源使用可展开 details；单向知晓继续用琥珀色及具名方向文字。

## Do's and Don'ts

### Do:

- Do 以 site.css 的后加载覆盖值为准，保留参考工程现有字体和构图语法。
- Do 保持首页体验与关系查阅的密度差异；长目录和弹层正文内部滚动。
- Do 为按钮、链接、输入与图节点保留可见键盘焦点，并尊重系统减弱动态设置。

### Don't:

- Don't 增添未经用户确认的视觉主题、装饰卡片体系或新的品牌字体。
- Don't 把琥珀关系状态色或粒子材质色扩展成全站主色。
- Don't 虚构官方徽记、立绘、关系资料或尚未确定的分区内容。
