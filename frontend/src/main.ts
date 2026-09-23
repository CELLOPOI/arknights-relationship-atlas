import { createApp, nextTick, type App } from 'vue';
import { directionBetween, sectionFor, transitionSection, type SectionDirection } from './section-navigation';
import './styles/graph.css';
import './styles/site.css';
import './styles/community.css';
import './styles/sources.css';

const entryFor = (path: string) => /^\/preferences\/?$/.test(path) ? 'preferences' : /^\/sources\/?$/.test(path) ? 'sources' : /^\/game\/?$/.test(path) ? 'game' : 'atlas';
const loadEntry = (path: string) => entryFor(path) === 'sources' ? import('./info/SourceNotice.vue')
  : entryFor(path) === 'preferences' ? import('./preferences/PreferencesApp.vue')
  : entryFor(path) === 'game' ? import('./game/GameApp.vue') : import('./App.vue');
let app: App, activeEntry = entryFor(location.pathname), request = 0;
let activeSection = sectionFor(new URL(location.href));

function cancelPendingNavigation() {
  if (!document.documentElement.dataset.sectionLoading) return;
  request++;
  delete document.documentElement.dataset.sectionLoading;
}

async function navigate(url: URL, direction: SectionDirection, pop = false) {
  const id = ++request;
  document.documentElement.dataset.sectionLoading = 'true';
  try {
    const { default: component } = await loadEntry(url.pathname);
    if (id !== request) return;
    delete document.documentElement.dataset.sectionLoading;
    const directory = new URL(location.href);
    directory.searchParams.delete('person'); directory.searchParams.delete('faction'); directory.hash = 'factions';
    const returnTo = activeEntry === 'atlas' ? directory.pathname + directory.search + directory.hash : history.state?.sectionReturn;
    await transitionSection(async () => {
      if (id !== request) return;
      // 先卸载旧入口，保证任一时刻只有一个应用拥有全局事件与图形资源。
      app.unmount();
      if (!pop) history.pushState({ sectionReturn: returnTo }, '', url);
      activeEntry = entryFor(url.pathname);
      activeSection = sectionFor(url);
      app = createApp(component); app.mount('#app');
      await nextTick();
      // AtlasShell 异步导入图形模块，等到页面状态应用后再拍摄新画面。
      if (activeEntry === 'atlas') {
        await import('./atlas/portal.js');
        await nextTick();
      }
    }, direction);
  } catch {
    // 代码分块读取或快照失败时退回原生导航，不能让普通链接失效。
    if (id === request) { if (pop) location.replace(url.href); else location.assign(url.href); }
  } finally {
    if (id === request) delete document.documentElement.dataset.sectionLoading;
  }
}

document.addEventListener('atlas:section-navigation', event => {
  const { href } = (event as CustomEvent<{ href: string; direction: SectionDirection }>).detail;
  event.preventDefault();
  const url = new URL(href, location.href);
  void navigate(url, directionBetween(sectionFor(new URL(location.href)), sectionFor(url)));
});
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !['/', '/game', '/game/', '/preferences', '/preferences/', '/sources', '/sources/'].includes(url.pathname)) return;
  if (entryFor(url.pathname) === activeEntry) { cancelPendingNavigation(); activeSection = sectionFor(url); return; }
  event.preventDefault();
  void navigate(url, directionBetween(sectionFor(new URL(location.href)), sectionFor(url)));
});
window.addEventListener('popstate', event => {
  if (entryFor(location.pathname) === activeEntry) { cancelPendingNavigation(); activeSection = sectionFor(new URL(location.href)); return; }
  // 旧图谱不能把游戏历史当成首页路由处理。
  event.stopImmediatePropagation();
  void navigate(new URL(location.href), directionBetween(activeSection, sectionFor(new URL(location.href))), true);
});
window.addEventListener('hashchange', () => { activeSection = sectionFor(new URL(location.href)); });
loadEntry(location.pathname).then(({ default: component }) => { app = createApp(component); app.mount('#app'); });
