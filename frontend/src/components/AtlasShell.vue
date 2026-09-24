<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import type { AtlasInstance } from '../types';
import SiteNoticeButton from './SiteNoticeButton.vue';
const emit = defineEmits<{ ready: [] }>();
let atlas: AtlasInstance | undefined;
let unmounted = false;
onMounted(async () => {
  const { createAtlas } = await import('../atlas/portal.js');
  if (unmounted) return;
  atlas = createAtlas(document.getElementById('app')!);
  emit('ready');
});
onBeforeUnmount(() => { unmounted = true; atlas?.dispose(); });
</script>
<template>
  <a class="skip-link" href="#workspace">跳到关系图</a>
  <svg class="svg-defs" aria-hidden="true">
    <defs>
      <!-- Symbols -->
      <symbol id="i-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <path d="m16.5 16.5 4.5 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
      </symbol>
      <symbol id="i-back" viewBox="0 0 24 24">
        <path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </symbol>
      <symbol id="i-grid" viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.75" fill="none"/>
      </symbol>
      <symbol id="i-fit" viewBox="0 0 24 24">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </symbol>
      <symbol id="i-reset" viewBox="0 0 24 24">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M3 3v5h5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </symbol>
      <symbol id="i-list" viewBox="0 0 24 24">
        <path d="M9 6h11M9 12h11M9 18h11M4 6h1.5M4 12h1.5M4 18h1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      </symbol>
      <symbol id="i-close" viewBox="0 0 24 24">
        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
      <symbol id="i-expand" viewBox="0 0 24 24">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </symbol>
      <symbol id="i-help" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </symbol>
      <symbol id="i-minus" viewBox="0 0 24 24">
        <path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </symbol>
      <symbol id="i-arrow-up-right" viewBox="0 0 24 24">
        <path d="M7 17L17 7M7 7h10v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </symbol>
      <symbol id="i-group-badge" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" fill="none"/>
        <circle cx="12" cy="12" r="4" fill="currentColor"/>
      </symbol>
    </defs>
  </svg>

  <header class="site-header">
    <a class="site-brand" href="#home" data-page="home"><span>方舟关系与喜好</span><small>ARKNIGHTS</small></a>
    <nav class="site-nav" aria-label="主导航">
      <a href="#home" data-page="home"><span>INDEX</span><small>首页</small></a>
      <a href="#factions" data-page="factions"><span>RELATIONS</span><small>人物关系</small></a>
      <a href="/game/"><span>GAME</span><small>游戏</small></a>
      <a href="/preferences/"><span>PREFERENCES</span><small>喜好</small></a>
      <SiteNoticeButton><span>NOTICE</span><small>站点说明</small></SiteNoticeButton>
    </nav>
    <div id="account-control"></div>
    <button id="site-menu-open" class="site-menu-toggle" aria-label="打开导航" aria-haspopup="dialog"><span></span><span></span><span></span></button>
  </header>

  <div id="portal" class="portal" data-scene="home">
    <div class="portal-rules" aria-hidden="true"></div>
    <div class="particle-stage" id="particle-stage">
      <canvas id="emblem-canvas" aria-label="可交互的阵营粒子徽记"></canvas>
      <div id="particle-loading" class="particle-status" role="status" hidden><span id="particle-message">正在载入徽记</span><button id="particle-retry" hidden>重新读取</button></div>
    </div>
    <main id="home-page" class="portal-route home-page" aria-label="首页">
      <div class="home-wordmark" aria-hidden="true">ARKNIGHTS</div>
      <div class="home-copy">
        <h1 tabindex="-1">方舟关系与喜好</h1>
        <a class="portal-enter" href="#factions" data-page="factions"><span>查看人物关系<small>EXPLORE RELATIONS</small></span><svg><use href="#i-arrow-up-right"/></svg></a>
      </div>
      <div class="home-caption"><span>RHODES ISLAND ://</span><span>人物 · 阵营 · 关系</span></div>
      <button class="scroll-cue" data-page="factions" aria-label="下一分区：干员"><span>SCROLL</span><svg><use href="#i-back"/></svg></button>
    </main>
    <main id="factions-page" class="portal-route factions-page" aria-label="干员阵营分区" hidden>
      <div class="faction-heading"><h1 tabindex="-1">干员</h1><span>OPERATOR</span></div>
      <div class="emblem-caption">
        <h2 id="emblem-name">罗德岛</h2>
        <p id="emblem-code">RHODES ISLAND</p>
        <div class="emblem-actions">
          <div class="emblem-steppers" role="group" aria-label="切换阵营预览">
            <button id="emblem-prev" aria-label="预览上一阵营"><svg aria-hidden="true"><use href="#i-back"/></svg></button>
            <button id="emblem-next" aria-label="预览下一阵营"><svg aria-hidden="true"><use href="#i-back"/></svg></button>
          </div>
          <a id="enter-faction" class="emblem-enter" href="?faction=rhodes#graph"><span id="emblem-count">查看人物关系</span><svg><use href="#i-arrow-up-right"/></svg></a>
        </div>
      </div>
      <div class="faction-directory">
        <div class="directory-heading"><div class="directory-title-group"><a id="directory-back" class="directory-back" data-directory="" href="#factions" aria-label="返回国家与阵营" hidden><svg aria-hidden="true"><use href="#i-back"/></svg><span>返回</span></a><h2 id="directory-title" tabindex="-1">国家与阵营</h2></div><span id="directory-count"></span></div>
        <p class="directory-instruction">选择一个阵营，进入人物关系图</p><div id="scope-control"></div>
        <nav id="faction-directory" aria-label="进入阵营关系图"></nav>
        <a class="all-operators" href="#graph" id="all-operators">全部人物关系<svg><use href="#i-arrow-up-right"/></svg></a>
      </div>
    </main>
    <div class="portal-footer"><a id="emblem-source" href="https://prts.wiki/" target="_blank" rel="noopener noreferrer">徽记来源 · PRTS</a><a class="local-credit source-notice-link" href="/sources/">来源与版权 · 非官方</a></div>
    <div class="section-marker" aria-hidden="true"><span id="section-number">00</span><small id="section-label">INDEX</small></div>
  </div>

  <div id="graph-page" class="graph-page" hidden>
  <header class="topbar">
    <div class="topbar-left">
      <button class="brand graph-return" id="home" aria-label="返回干员阵营分区">
        <svg><use href="#i-grid"/></svg><span>阵营分区</span>
      </button>

      <div class="header-divider" aria-hidden="true"></div>

      <button class="nav-button" id="back" aria-label="返回">
        <svg><use href="#i-back"/></svg>
        <span>返回总览</span>
      </button>
    </div>

    <!-- Spotlight Search -->
    <div class="search-container">
      <div class="search-wrap">
        <svg aria-hidden="true"><use href="#i-search"/></svg>
        <input id="search" placeholder="搜索代号、真名或异格" aria-label="搜索干员代号、真名或异格" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="search-results" disabled>
        <kbd aria-hidden="true">/</kbd>
      </div>
      <div id="search-results" class="search-results" role="listbox" hidden></div>
    </div>

    <div class="topbar-right">
      <div class="system-status">
        <span class="status-label" id="archive-status">正在读取档案</span>
      </div>
      <button class="help-button" id="help" aria-label="查看操作指南与系统说明">
        <svg><use href="#i-help"/></svg>
        <span class="help-text">指南</span>
      </button>
    </div>
  </header>

  <!-- Main Application Body -->
  <div class="app-layout">
    <!-- Faction Index Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">阵营索引</span>
        <span class="sidebar-count" id="faction-total"></span>
      </div>
      <nav id="factions" aria-label="阵营索引导航" class="faction-nav">
        <!-- Generated by app.js -->
        <button class="faction-button active" data-faction="all">
          <span class="faction-name">全部阵营</span>
          <span class="faction-count">396</span>
        </button>
      </nav>
    </aside>

    <!-- Graph Workspace Area -->
    <main id="workspace" tabindex="-1" aria-busy="true">
      <!-- HUD View Heading -->
      <div class="view-heading">
        <div class="heading-copy">
          <h1 id="view-title" tabindex="-1">阵营总览</h1>
          <p id="view-subtitle" aria-live="polite">正在读取关系资料</p>
        </div>

        <div class="view-options">
          <details id="graph-settings" class="graph-settings">
            <summary>显示选项<svg aria-hidden="true"><use href="#i-back"/></svg></summary>
            <div class="graph-preferences">
              <label class="toggle-control"><input id="graph-motion" type="checkbox" checked><span class="toggle-track"></span><span class="toggle-text">泡泡动态</span></label>
              <label class="toggle-control"><input id="show-lines" type="checkbox"><span class="toggle-track"></span><span class="toggle-text">全部连线</span></label>
              <label class="toggle-control" id="neighbors-label">
                <input id="neighbors" type="checkbox">
                <span class="toggle-track"></span>
                <span class="toggle-text">周围关系</span>
              </label>
            </div>
          </details>
          <div id="person-actions"></div><span class="view-context" id="view-context">全部阵营</span>
        </div>
      </div>

      <section class="operator-strip" aria-label="干员探索起点">
        <div class="strip-label"><span>从一位干员开始</span><small>点击头像，展开关系</small></div>
        <button class="strip-arrow" id="operators-prev" aria-label="向前浏览干员" disabled><svg><use href="#i-back"/></svg></button>
        <div id="operator-shortcuts" class="operator-shortcuts" aria-label="快速切换干员"></div>
        <button class="strip-arrow" id="operators-next" aria-label="向后浏览干员" disabled><svg><use href="#i-back"/></svg></button>
      </section>

      <!-- Graph Canvas Stage -->
      <div class="graph-stage" id="graph-stage">
        <nav id="group-browser" class="group-browser" aria-label="当前关系分组" hidden>
          <div class="group-browser-heading">
            <button id="group-back" class="hud-button" type="button"><svg aria-hidden="true"><use href="#i-back"/></svg><span>全部分组</span></button>
            <strong id="group-title" tabindex="-1"></strong>
            <button id="group-members" class="hud-button" type="button" aria-haspopup="dialog">本组名录</button>
          </div>
          <div class="group-pagination">
            <span id="group-range" role="status" aria-live="polite"></span>
            <button id="group-prev" class="hud-button icon-btn" type="button" aria-label="上一页人物"><svg aria-hidden="true"><use href="#i-back"/></svg></button>
            <button id="group-next" class="hud-button icon-btn" type="button" aria-label="下一页人物"><svg aria-hidden="true"><use href="#i-back"/></svg></button>
          </div>
        </nav>
        <svg id="graph" aria-label="干员关系交互拓扑图谱" role="group">
          <defs id="graph-defs"></defs>
          <g id="world">
            <g id="regions"></g>
            <g id="edges"></g>
            <g id="graph-sparks" aria-hidden="true" pointer-events="none"></g>
            <g id="nodes"></g>
          </g>
        </svg>

        <div class="stage-caption" aria-hidden="true"><span id="stage-caption">全部阵营 · 人物关系网络</span><span>拖动画布探索</span></div>
        <div id="node-preview" class="node-preview" role="tooltip" hidden></div>
        <div id="loading" class="stage-state loading-state" role="status"><span class="loading-line"></span><p>正在读取档案…</p></div>

        <div id="empty-state" class="stage-state empty-state" hidden></div>
      </div>

      <!-- Floating Tactical Bottom HUD -->
      <div class="bottom-bar">
        <div class="hud-panel graph-key">
          <div class="legend-item"><span class="legend-line"></span><span>已核实关系</span></div>
          <div class="legend-item group-item">
            <svg class="legend-badge-icon"><use href="#i-group-badge"/></svg>
            <span>点击分组逐组查看</span>
          </div>
          <span class="graph-hint">相识类型与方向见详情</span>
        </div>

        <div class="hud-panel canvas-actions">
          <div class="action-group cluster-actions">
            <button id="expand-all" class="hud-button" title="展开所有聚合分组" aria-label="全部展开">
              <svg><use href="#i-expand"/></svg>
              <span>全部展开</span>
            </button>
            <button id="collapse-all" class="hud-button" title="收起所有分组" aria-label="全部收起">
              <svg><use href="#i-grid"/></svg>
              <span>全部收起</span>
            </button>
            <button id="open-list" class="hud-button primary-action" title="打开完整人物名录" aria-haspopup="dialog">
              <svg><use href="#i-list"/></svg>
              <span>人物名录</span>
            </button>
          </div>

          <div class="action-group zoom-actions">
            <button id="zoom-out" class="hud-button icon-btn" aria-label="缩小画布" title="缩小">
              <svg><use href="#i-minus"/></svg>
            </button>
            <span id="zoom-label" class="zoom-indicator">100%</span>
            <button id="zoom-in" class="hud-button icon-btn" aria-label="放大画布" title="放大">
              <svg><use href="#i-plus"/></svg>
            </button>
            <div class="action-divider" aria-hidden="true"></div>
            <button id="fit" class="hud-button" title="适应当前视口">
              <svg><use href="#i-fit"/></svg>
              <span>适应</span>
            </button>
            <button id="reset" class="hud-button" title="重置拖动与视角">
              <svg><use href="#i-reset"/></svg>
              <span>重置</span>
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>

  </div>

  <!-- PRTS Classified Information Drawer / Detail Panel -->
  <dialog id="panel" class="detail-panel" aria-label="PRTS 档案详情">
    <div class="panel-header-bar">
      <div class="panel-badge-wrap">
        <span class="panel-tag">PRTS DOSSIER</span>
      </div>
      <button id="close-panel" class="panel-close-btn" aria-label="关闭详情面板">
        <svg><use href="#i-close"/></svg>
      </button>
    </div>
    <div id="panel-content" class="panel-body"></div>
  </dialog>

  <dialog id="site-menu" class="site-menu" aria-label="网站导航"><button id="site-menu-close" aria-label="关闭导航"><svg><use href="#i-close"/></svg></button><a href="#home" data-page="home">INDEX <span>首页</span></a><a href="#factions" data-page="factions">RELATIONS <span>人物关系</span></a><a href="/game/">GAME <span>游戏</span></a><a href="/preferences/">PREFERENCES <span>喜好</span></a><SiteNoticeButton>NOTICE <span>站点说明</span></SiteNoticeButton><a href="/sources/">SOURCES <span>来源与版权</span></a></dialog>

  <!-- Global Toast Notification -->
  <div id="toast" class="toast-alert" role="status" hidden></div>


</template>
