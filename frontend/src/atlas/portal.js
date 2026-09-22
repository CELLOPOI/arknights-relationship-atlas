import { createGraph } from './graph.js';
import { createLifecycle } from './lifecycle.js';
import { ParticleField, sampleEmblem } from './particles.js';

// 同一 DOM 根只允许一个实例，也覆盖 Vite 热更新后的新模块版本。
const instanceKey = Symbol.for('arknights.atlas.instance');
/** 同一根节点重复初始化时先销毁旧实例，ESM import 本身不注册任何监听。
 * @param {ParentNode} root
 */
export function createAtlas(root = document) {
root[instanceKey]?.dispose();
const lifecycle = createLifecycle();
const graphInstance = createGraph(root);
const { ready: graphReady, enterGraph, leaveGraph, restoreGraph } = graphInstance;
const $ = selector => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const names = { rhodes: 'RHODES ISLAND', egir: 'AEGIR', rim: 'RIM BILLITON', rainbow: 'RAINBOW', laios: 'LAIOS', mujica: 'AVE MUJICA', sees: 'S.E.E.S.', collaboration: 'CROSSOVER', unknown: 'UNAFFILIATED' };
// 联动仅合并浏览入口，人物数据与图谱中的四支小队仍保留各自的阵营 ID。
const collaborationIds = ['laios', 'mujica', 'sees', 'rainbow'];
const isCollaboration = id => collaborationIds.includes(id);
const previewId = id => isCollaboration(id) ? 'collaboration' : id;
let graph, icons = [], field, page = '', activeIndex = 0, requestId = 0, requestedIndex = 0;
let directoryGroup = null;
let pageAnimation, switchUntil = 0, lastURL = '', contextLost = false;
const samples = new Map();
const pageOrder = { home: 0, factions: 1, graph: 2 };

function factionLink(id) {
  const params = new URLSearchParams({ faction: id });
  if (isCollaboration(id)) params.set('group', 'collaboration');
  if (new URLSearchParams(location.search).get('scope') === 'all') params.set('scope', 'all');
  return '?' + params + '#graph';
}

function directoryLink(group = null) {
  const params = new URLSearchParams();
  if (group) params.set('group', group);
  if (new URLSearchParams(location.search).get('scope') === 'all') params.set('scope', 'all');
  return (params.size ? '?' + params : location.pathname) + '#factions';
}

function currentRoute() {
  const url = new URL(location.href);
  const section = url.hash.slice(1);
  const faction = url.searchParams.get('faction');
  const group = url.searchParams.get('group') === 'collaboration' || isCollaboration(faction) ? 'collaboration' : null;
  return { page: section === 'graph' || (!section && (url.searchParams.has('person') || faction)) ? 'graph' : section === 'factions' ? 'factions' : 'home', faction, person: url.searchParams.get('person'), group };
}

function syncPlayback() {
  if (!field) return;
  field.setReducedMotion(reduced.matches);
  if (page === 'graph' || document.hidden || reduced.matches || contextLost) field.pause();
  else field.resume();
}

function showPage(next, { animate = true } = {}) {
  const previous = page;
  page = next;
  pageAnimation?.cancel();
  $('#portal').hidden = next === 'graph';
  $('#graph-page').hidden = next !== 'graph';
  $('#home-page').hidden = next !== 'home';
  $('#factions-page').hidden = next !== 'factions';
  $('#portal').dataset.scene = next;
  document.body.dataset.page = next;
  $('#section-number').textContent = next === 'home' ? '00' : '01';
  $('#section-label').textContent = next === 'home' ? 'INDEX' : 'OPERATOR';
  root.querySelectorAll('.site-nav [data-page]').forEach(link => {
    const active = link.dataset.page === (next === 'graph' ? 'factions' : next);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if ($('#site-menu').open) $('#site-menu').close();
  const surface = next === 'graph' ? $('#graph-page') : next === 'home' ? $('#home-page') : $('#factions-page');
  const duration = matchMedia('(orientation: portrait)').matches ? 600 : 1000;
  switchUntil = performance.now() + (reduced.matches ? 0 : duration);
  if (animate && previous && previous !== next && !reduced.matches) {
    const forward = pageOrder[next] >= pageOrder[previous];
    pageAnimation = lifecycle.animate(surface, [{ clipPath: forward ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration, easing: 'cubic-bezier(.455, .03, .515, .955)' });
  }
  $('.emblem-steppers').hidden = next === 'factions' && directoryGroup === 'collaboration';
  field?.resize();
  // 首页与干员页共用徽记缓存；进入干员页仍要按新画布尺寸立即重播入场。
  if (next !== 'graph' && icons.length) selectEmblem(next === 'home' ? 0 : activeIndex, { replay: next === 'factions' && previous !== next });
  syncPlayback();
  document.title = next === 'home' ? '干员关系档案 · 明日方舟' : next === 'factions' ? (directoryGroup ? '联动 · 干员关系档案' : '干员 · 国家与阵营') : '人物关系图 · 干员关系档案';
  lastURL = location.href;
}

function go(next) {
  if (next === 'factions') { openDirectory(); return; }
  if (next === page) return;
  if (page === 'graph') leaveGraph();
  const url = new URL(location.href);
  url.searchParams.delete('person'); url.searchParams.delete('faction'); url.searchParams.delete('group'); url.hash = next;
  directoryGroup = null;
  history.pushState({ page: next, depth: (history.state?.depth || 0) + 1 }, '', url);
  showPage(next);
  (next === 'home' ? $('#home-page h1') : $('#factions-page h1')).focus({ preventScroll: true });
}

function openDirectory(group = null) {
  if (page === 'factions' && directoryGroup === group) {
    $('#faction-directory a')?.focus({ preventScroll: true });
    return;
  }
  if (page === 'graph') leaveGraph();
  history.pushState({ page: 'factions', depth: (history.state?.depth || 0) + 1 }, '', directoryLink(group));
  applyRoute();
  $('#directory-title').focus({ preventScroll: true });
}

function openFaction(id) {
  const target = graph?.factions.find(faction => faction.id === id);
  showPage('graph');
  if (graph) enterGraph(target?.id || null);
  else {
    const url = new URL(location.href); url.hash = 'graph'; url.searchParams.delete('person');
    if (isCollaboration(id)) url.searchParams.set('group', 'collaboration');
    if (id) url.searchParams.set('faction', id); else url.searchParams.delete('faction');
    history.pushState({ page: 'graph' }, '', url);
  }
  lastURL = location.href;
}

function applyRoute({ initial = false } = {}) {
  const route = currentRoute();
  if (!initial && lastURL === location.href) return;
  directoryGroup = route.group;
  if (route.page === 'factions' && directoryGroup) {
    const index = icons.findIndex(icon => icon.id === directoryGroup);
    if (index >= 0) activeIndex = index;
  }
  buildDirectory();
  // popstate 已切换 URL，此处不能把离开的图谱写进目的页历史。
  showPage(route.page, { animate: !initial });
  if (route.page === 'graph' && graph) {
    const state = history.state;
    if (state?.page === 'graph' && state.focus === route.person && state.scopeFaction === route.faction) restoreGraph(state);
    else enterGraph(route.faction, route.person, { replace: true });
  }
  lastURL = location.href;
}

function setParticleStatus(message, retry = false) {
  $('#particle-message').textContent = message;
  $('#particle-loading').hidden = !message;
  $('#particle-retry').hidden = !retry;
}

function syncEmblemCopy(icon) {
  $('#emblem-name').textContent = icon.name;
  $('#emblem-code').textContent = names[icon.id] || icon.id.toUpperCase();
  const grouped = icon.id === 'collaboration';
  const count = graph?.nodes.filter(node => grouped ? isCollaboration(node.factionId) : node.factionId === icon.id).length;
  const groups = graph?.factions.filter(faction => isCollaboration(faction.id)).length;
  $('#emblem-count').textContent = grouped ? `${groups ?? 4} 支小队${count === undefined ? '' : ` · ${count} 位人物`} · 选择小队` : count === undefined ? '进入人物关系图' : `${count} 位人物 · 进入关系图`;
  const entry = $('#enter-faction');
  entry.href = grouped ? directoryLink('collaboration') : factionLink(icon.id);
  if (grouped) { entry.dataset.directory = 'collaboration'; delete entry.dataset.enter; }
  else { entry.dataset.enter = icon.id; delete entry.dataset.directory; }
  $('#emblem-source').href = icon.source || 'https://prts.wiki/';
  $('#emblem-canvas').setAttribute('aria-label', grouped ? '联动分组的交互粒子图案，采用彩虹小队徽记' : `${icon.name}${icon.file ? '徽记' : '分组'}的交互粒子图案`);
  root.querySelectorAll('.faction-entry').forEach(link => link.setAttribute('aria-current', String((link.dataset.directory || link.dataset.enter) === icon.id)));
}

async function selectEmblem(index, { replay = false } = {}) {
  const icon = icons[index];
  if (!icon || !field || contextLost) return;
  requestedIndex = index;
  const request = ++requestId;
  activeIndex = index;
  syncEmblemCopy(icon);
  setParticleStatus('');
  $('#particle-stage').setAttribute('aria-busy', 'true');
  try {
    let sample;
    if (icon.file) {
      if (!samples.has(icon.id)) samples.set(icon.id, sampleEmblem(icon.file, field.count, lifecycle.signal).catch(error => { samples.delete(icon.id); throw error; }));
      sample = await samples.get(icon.id);
    } else sample = { points: field.cloud.slice() };
    if (lifecycle.disposed || request !== requestId) return;
    field.setEmblem(sample, { id: icon.id, replay });
    if (!icon.file && page === 'factions') setParticleStatus('暂无已核实徽记，以无标识粒子展示');
    $('#emblem-canvas').hidden = false;
    $('#particle-stage').setAttribute('aria-busy', 'false');
    syncPlayback();
  } catch {
    if (lifecycle.disposed || request !== requestId) return;
    field.pause();
    $('#emblem-canvas').hidden = true;
    $('#particle-stage').setAttribute('aria-busy', 'false');
    setParticleStatus('徽记读取失败，可重试或选择其他阵营。', true);
  }
}

function buildDirectory() {
  if (!graph) return;
  const nested = directoryGroup === 'collaboration';
  const teams = collaborationIds.map(id => graph.factions.find(faction => faction.id === id)).filter(Boolean);
  let addedGroup = false;
  const entries = nested ? teams : graph.factions.flatMap(faction => {
    if (!isCollaboration(faction.id)) return [faction];
    if (addedGroup) return [];
    addedGroup = true;
    return [{ id: 'collaboration', name: '联动' }];
  });
  $('#directory-title').textContent = nested ? '联动' : '国家与阵营';
  $('#directory-count').textContent = `${entries.length} ${nested ? '支小队' : '个分组'}`;
  $('#directory-back').hidden = !nested;
  $('#directory-back').href = directoryLink();
  $('.directory-instruction').textContent = nested ? '选择一支联动小队，进入人物关系图' : '选择一个阵营，进入人物关系图';
  $('#faction-directory').setAttribute('aria-label', nested ? '联动小队' : '国家与阵营');
  $('#faction-directory').innerHTML = entries.map(faction => {
    const grouped = faction.id === 'collaboration';
    const count = graph.nodes.filter(node => grouped ? isCollaboration(node.factionId) : node.factionId === faction.id).length;
    const destination = grouped ? `data-directory="collaboration" href="${esc(directoryLink('collaboration'))}"` : `data-enter="${esc(faction.id)}" href="${esc(factionLink(faction.id))}"`;
    return `<a class="faction-entry" ${destination}><span><strong>${esc(faction.name)}</strong><small>${esc(names[faction.id] || faction.id.toUpperCase())}</small></span><em>${grouped ? `${teams.length} 小队 · ` : ''}${count} 人</em><svg aria-hidden="true"><use href="#i-arrow-up-right"/></svg></a>`;
  }).join('');
  $('#faction-directory').scrollTop = 0;
  if (icons[activeIndex]) syncEmblemCopy(icons[activeIndex]);
}

function keepPopulatedIcons() {
  if (!graph || !icons.length) return;
  const active = icons[activeIndex]?.id;
  icons = icons.filter(icon => graph.factions.some(faction => icon.id === 'collaboration' ? isCollaboration(faction.id) : faction.id === icon.id));
  activeIndex = Math.max(0, icons.findIndex(icon => icon.id === active));
}

lifecycle.listen($('#faction-directory'), 'pointerover', event => {
  if (!finePointer.matches || event.pointerType !== 'mouse') return;
  const link = event.target.closest('.faction-entry');
  const index = icons.findIndex(icon => icon.id === previewId(link?.dataset.directory || link?.dataset.enter));
  if (index >= 0 && index !== activeIndex) selectEmblem(index);
});
lifecycle.listen($('#faction-directory'), 'focusin', event => {
  const link = event.target.closest('.faction-entry');
  const index = icons.findIndex(icon => icon.id === previewId(link?.dataset.directory || link?.dataset.enter));
  if (index >= 0 && index !== activeIndex) selectEmblem(index);
});

lifecycle.listen(document, 'click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  // body 的 data-page 只标记当前分区，不能作为导航点击目标，否则会阻止社区表单提交。
  const link = event.target.closest('a[data-page], button[data-page], [data-enter], [data-directory]');
  if (!link) return;
  event.preventDefault();
  if (link.dataset.page) go(link.dataset.page);
  else if ('directory' in link.dataset) openDirectory(link.dataset.directory || null);
  else openFaction(link.dataset.enter);
});
lifecycle.handler($('#all-operators'), 'onclick', event => { if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); openFaction(null); } });
lifecycle.handler($('#home'), 'onclick', () => openDirectory(currentRoute().group));
lifecycle.handler($('#back'), 'onclick', () => history.state?.depth > 0 ? history.back() : openDirectory(currentRoute().group));
lifecycle.handler($('#site-menu-open'), 'onclick', () => $('#site-menu').showModal());
lifecycle.handler($('#site-menu-close'), 'onclick', () => $('#site-menu').close());
lifecycle.listen($('#site-menu'), 'click', event => { if (event.target === $('#site-menu') && event.clientY > $('#site-menu').getBoundingClientRect().bottom) $('#site-menu').close(); });
for (const [id, delta] of [['emblem-prev', -1], ['emblem-next', 1]]) lifecycle.handler($('#' + id), 'onclick', () => selectEmblem((activeIndex + delta + icons.length) % icons.length));
lifecycle.handler($('#particle-retry'), 'onclick', () => contextLost || !field ? location.reload() : selectEmblem(requestedIndex));

lifecycle.listen($('#portal'), 'wheel', event => {
  if (event.target.closest('.faction-directory, button, a') || performance.now() < switchUntil) return;
  if (Math.abs(event.deltaY) < 12) return;
  if (page === 'home' && event.deltaY > 0) { event.preventDefault(); go('factions'); }
  else if (page === 'factions' && event.deltaY < 0) { event.preventDefault(); go('home'); }
  else if (page === 'factions' && event.deltaY > 0) { event.preventDefault(); location.assign('/game/'); }
}, { passive: false });
let touchStart;
lifecycle.listen($('#portal'), 'touchstart', event => {
  if (event.target.closest('.particle-stage, .faction-directory, button, a') || event.touches.length !== 1) { touchStart = null; return; }
  touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
lifecycle.listen($('#portal'), 'touchend', event => {
  if (!touchStart || performance.now() < switchUntil) { touchStart = null; return; }
  const touch = event.changedTouches[0], dx = touch.clientX - touchStart.x, dy = touch.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 50 || Math.abs(dy) < 70) return;
  if (page === 'home' && dy < 0) go('factions'); else if (page === 'factions' && dy > 0) go('home');
}, { passive: true });
lifecycle.listen($('#portal'), 'touchcancel', () => { touchStart = null; });
lifecycle.listen(window, 'popstate', () => applyRoute());
lifecycle.listen(window, 'hashchange', () => applyRoute());
lifecycle.listen(document, 'atlas:view', () => { if (page !== 'graph') showPage('graph'); lastURL = location.href; });
lifecycle.listen(document, 'visibilitychange', syncPlayback);
lifecycle.listen(reduced, 'change', () => { pageAnimation?.cancel(); switchUntil = 0; syncPlayback(); });

applyRoute({ initial: true });
graphReady.then(data => { if (lifecycle.disposed || !data) return; graph = graph || data; keepPopulatedIcons(); buildDirectory(); applyRoute({ initial: true }); });

async function initializeParticles() {
  ({ icons } = await lifecycle.json('assets/emblems.json'));
  if (lifecycle.disposed) return;
  // 按用户指定，用彩虹小队的既有粒子效果表示“联动”，不再展示其他小队的占位徽记。
  icons = icons.flatMap(icon => icon.id === 'rainbow' ? [{ ...icon, id: 'collaboration', name: '联动' }] : isCollaboration(icon.id) ? [] : [icon]);
  keepPopulatedIcons();
  field = new ParticleField($('#emblem-canvas'), { interactionTarget: $('#particle-stage'), reducedMotion: reduced.matches, onError: () => {
    contextLost = true;
    $('#emblem-canvas').hidden = true;
    setParticleStatus('粒子画面已中断，重新读取可恢复。', true);
  } });
  syncPlayback();
  buildDirectory();
  const route = currentRoute();
  const initial = icons.findIndex(icon => icon.id === (route.group || previewId(route.faction)));
  activeIndex = initial >= 0 ? initial : 0;
  await selectEmblem(activeIndex);
  if (!lifecycle.disposed) syncPlayback();
}
initializeParticles().catch(() => { if (!lifecycle.disposed) setParticleStatus('徽记暂不可用，仍可进入关系图。', true); });
const publicApi = Object.freeze({ getState: () => ({ page, directoryGroup, activeFaction: icons[activeIndex]?.id, requestedIndex, paused: field?.paused, ...field?.getState() }) });

window.terraPortal = publicApi;
const instance = {
  ready: graphReady,
  /** @param {import('../types').AtlasData} next */
  update(next) {
    if (lifecycle.disposed) return;
    graph = graphInstance.update(next);
    keepPopulatedIcons(); buildDirectory(); applyRoute({ initial: true });
  },
  dispose() {
    if (lifecycle.disposed) return;
    requestId++;
    lifecycle.dispose();
    field?.dispose();
    graphInstance.dispose();
    samples.clear();
    $('#site-menu').close();
    if (window.terraPortal === publicApi) { delete window.terraPortal; delete document.body.dataset.page; }
    if (root[instanceKey] === instance) delete root[instanceKey];
  },
};
root[instanceKey] = instance;
return instance;
}
