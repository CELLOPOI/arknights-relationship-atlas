import { assetUrl } from '../asset-url';
import { GraphMotion, curveBetween } from './graph-motion.js';
import { createLifecycle } from './lifecycle.js';
import { validateAtlasData } from './data.js';
import { renderSources } from '../source-display.js';

/** @param {ParentNode} root */
export function createGraph(root = document) {
const lifecycle = createLifecycle();
let panelEvents = createLifecycle();
lifecycle.own(() => panelEvents.dispose());

const $ = selector => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avatar = id => assetUrl(byId?.get(id)?.avatar || '/avatars/unknown.svg');
const svg = $('#graph'), world = $('#world'), nodesLayer = $('#nodes'), edgesLayer = $('#edges'), regionsLayer = $('#regions');
/** @type {import('../types').AtlasData | undefined} */
let data;
let byId, byEdge, adj, factionById;
let focus = null, scopeFaction = null, expanded = new Set(), neighbors = false, positions = new Map(), groups = [], visibleNodes = [], visibleEdges = [], regions = [], camera = { x: 0, y: 0, k: 1 }, activeFaction = null;
let groupView = null, groupOverview = null, dragged = new Set(), listIds = null;
// 自动布局与手动拖动的状态边界见 docs/RELATION_GROUPS.md。
let layoutVersion = 3;
let renderedViewport = { width: 0, height: 0 };
let restoredViewport = null;
let panelMode = null, lastFocus = null, toastTimer, searchIndex = -1, searchMatches = [], renderSequence = 0;
const viewCache = new Map();
const pointers = new Map();
let gesture = null, pinch = null, hovered = null, historyDepth = 0, historyTimer;
const NS = 'http://www.w3.org/2000/svg';
const getEdges = id => adj.get(id) || [];
const other = (edge, id) => edge.source === id ? edge.target : edge.source;
const centerId = 'char_003_kalts';
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const compactLandscape = matchMedia('(max-height: 560px) and (orientation: landscape)');
let viewAnimations = [], panelAnimation, panelClosing = false, listKind = 'all';
let previewFrame, previewTarget, previewPosition, previewNode;
let edgeClearTimer, showAllLines = false, motionPaused = false;
try { motionPaused = localStorage.getItem('atlas:graph-motion') === 'paused'; } catch { /* 禁用存储时仍可在当前页面切换。 */ }
const graphMotion = new GraphMotion({ svg, nodes: nodesLayer, edges: edgesLayer, sparks: $('#graph-sparks'), position: currentPoint, camera: () => camera });
const cacheKey = () => `${scopeFaction || 'all'}:${focus || 'overview'}`;
let resolveReady;
const graphReady = new Promise(resolve => { resolveReady = resolve; });

function animateView(direction = 1) {
  viewAnimations.forEach(animation => animation.cancel());
  viewAnimations = [];
  hidePreview();
  if (motionPreference.matches) return;
  const duration = matchMedia('(max-width: 760px)').matches ? 180 : 260;
  viewAnimations = [
    lifecycle.animate($('.heading-copy'), [{ opacity: .5, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], { duration, easing: 'cubic-bezier(.16, 1, .3, 1)' })
  ];
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  lifecycle.clearTimeout(toastTimer);
  toastTimer = lifecycle.timeout(() => el.hidden = true, 3000);
}

function point(event) {
  const b = svg.getBoundingClientRect();
  return { x: event.clientX - b.left, y: event.clientY - b.top };
}

function toWorld(p) {
  return { x: (p.x - camera.x) / camera.k, y: (p.y - camera.y) / camera.k };
}

function applyCamera() {
  world.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.k})`);
  $('#zoom-label').textContent = `${Math.round(camera.k * 100)}%`;
  svg.classList.toggle('zoomed-out', camera.k < 0.47);
  svg.style.setProperty('--region-font', Math.max(16, 11 / camera.k) + 'px');
  svg.style.setProperty('--group-font', Math.max(22, 12 / camera.k) + 'px');
  svg.style.setProperty('--group-count-font', Math.max(18, 10 / camera.k) + 'px');
  svg.style.setProperty('--detail-font', Math.max(16, 13 / camera.k) + 'px');
  // 字号在缩小时保持可读，标签行距也必须同步保持，避免低高度横屏叠字。
  svg.querySelectorAll('.group-name').forEach(label => label.setAttribute('y', -Math.max(16, 6 / camera.k)));
  svg.querySelectorAll('.group-count').forEach(label => label.setAttribute('y', Math.max(14, 8 / camera.k)));
  svg.querySelectorAll('.group-plus').forEach(mark => mark.setAttribute('transform', `translate(0 ${Math.max(0, 17 / camera.k - 43)})`));
  lifecycle.clearTimeout(historyTimer);
  historyTimer = lifecycle.timeout(() => {
    if (data && renderSequence && location.hash === '#graph') history.replaceState(snapshot(), '', location.href);
  }, 80);
}

function zoom(factor, anchor) {
  anchor = anchor || { x: svg.clientWidth / 2, y: svg.clientHeight / 2 };
  const before = toWorld(anchor);
  camera.k = Math.min(3, Math.max(0.1, camera.k * factor));
  camera.x = anchor.x - before.x * camera.k;
  camera.y = anchor.y - before.y * camera.k;
  applyCamera();
}

function fit(bounds) {
  if (!visibleNodes.length) return;
  const list = bounds || visibleNodes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of list) {
    const p = positions.get(n.id) || n;
    const rx = (n.rx || n.r) + 24, ry = (n.ry || n.r) + (groupView ? 0 : 24);
    minX = Math.min(minX, p.x - rx);
    maxX = Math.max(maxX, p.x + rx);
    minY = Math.min(minY, p.y - ry - (groupView ? 4 : 20));
    maxY = Math.max(maxY, p.y + ry + (groupView ? n.center ? 32 : 24 : 28));
  }
  if (!bounds) {
    for (const reg of regions) {
      minX = Math.min(minX, reg.x - (reg.rx || reg.r));
      maxX = Math.max(maxX, reg.x + (reg.rx || reg.r));
      minY = Math.min(minY, reg.y - (reg.ry || reg.r) - 28);
      maxY = Math.max(maxY, reg.y + (reg.ry || reg.r));
    }
  }
  const width = svg.clientWidth, height = svg.clientHeight;
  if (!width || !height) return;
  renderedViewport = { width, height };
  const compact = compactLandscape.matches;
  const top = groupView ? (width < 600 ? 102 : compact ? 62 : 72) : compact ? 6 : 38;
  const bottom = groupView ? (compact ? 8 : 24) : compact ? 6 : 38;
  const k = Math.min(1.35, Math.max(0.1, Math.min((width - (compact ? 24 : 48)) / (maxX - minX || 1), (height - top - bottom) / (maxY - minY || 1))));
  camera = { k, x: width / 2 - (minX + maxX) / 2 * k, y: (height + top - bottom + (groupView || compact ? 0 : 20)) / 2 - (minY + maxY) / 2 * k };
  applyCamera();
}

function snapshot() {
  return { page: 'graph', layoutVersion, viewport: { width: svg.clientWidth, height: svg.clientHeight }, depth: historyDepth, scopeFaction, focus, expanded: [...expanded], neighbors, coords: Object.fromEntries(positions), dragged: [...dragged], camera: { ...camera }, activeFaction, groupView: groupView && { ...groupView }, groupOverview };
}

function saveCurrent() {
  if (!data || !renderSequence || location.hash !== '#graph') return;
  const state = snapshot();
  viewCache.set(cacheKey(), state);
  history.replaceState(state, '', location.href);
}

function navigate(id, { replace = false, state = null, save = true } = {}) {
  if (lifecycle.disposed) return;
  if (id && !byId.has(id)) return;
  lifecycle.clearTimeout(historyTimer);
  if (save) saveCurrent();
  historyDepth = history.state?.depth || 0;
  if (!replace) historyDepth++;
  focus = id;
  activeFaction = null;
  closePanel(true);
  $('#search-results').hidden = true;
  $('#search').value = '';
  $('#search').setAttribute('aria-expanded', 'false');

  const cached = state || viewCache.get(cacheKey());
  const validLayout = cached?.layoutVersion === layoutVersion;
  restoredViewport = validLayout ? cached.viewport || null : null;
  expanded = new Set(cached?.expanded || []);
  neighbors = cached?.neighbors || false;
  positions = new Map(Object.entries(validLayout ? cached.coords || {} : {}));
  dragged = new Set(validLayout ? cached.dragged || [] : []);
  groupView = validLayout && cached.groupView ? { ...cached.groupView } : null;
  groupOverview = validLayout ? cached.groupOverview || null : null;
  camera = cached?.camera ? { ...cached.camera } : { x: 0, y: 0, k: 1 };
  activeFaction = cached?.activeFaction || null;

  if (!cached && id) {
    const links = getEdges(id);
    if (links.length <= 36) expanded.add('*');
  }

  const url = new URL(location.href);
  url.hash = 'graph';
  if (scopeFaction) url.searchParams.set('faction', scopeFaction);
  else url.searchParams.delete('faction');
  if (id) url.searchParams.set('person', id);
  else url.searchParams.delete('person');

  render({ fitView: !validLayout });
  const next = snapshot();
  if (replace) history.replaceState(next, '', url);
  else history.pushState(next, '', url);
  animateView();
  document.dispatchEvent(new CustomEvent('atlas:view', { detail: next }));
}

function restoreGraph(state) {
  if (lifecycle.disposed) return;
  if ((state?.focus && !byId.has(state.focus)) || (state?.scopeFaction && !factionById.has(state.scopeFaction))) {
    enterGraph(factionById.has(state?.scopeFaction) ? state.scopeFaction : null, byId.has(state?.focus) ? state.focus : null, { replace: true });
    return;
  }
  graphMotion.setActive(true);
  const validLayout = state?.layoutVersion === layoutVersion;
  restoredViewport = validLayout ? state.viewport || null : null;
  historyDepth = state?.depth || 0;
  focus = state?.focus || null;
  scopeFaction = state?.scopeFaction || null;
  expanded = new Set(state?.expanded || []);
  neighbors = !!state?.neighbors;
  positions = new Map(Object.entries(validLayout ? state.coords || {} : {}));
  dragged = new Set(validLayout ? state.dragged || [] : []);
  groupView = validLayout && state.groupView ? { ...state.groupView } : null;
  groupOverview = validLayout ? state.groupOverview || null : null;
  camera = state?.camera ? { ...state.camera } : { x: 0, y: 0, k: 1 };
  activeFaction = state?.activeFaction || null;
  closePanel(true);
  render({ fitView: !validLayout || !state?.camera });
  animateView(-1);
  document.dispatchEvent(new CustomEvent('atlas:view', { detail: snapshot() }));
}

function enterGraph(faction, person = null, { replace = false, state = null } = {}) {
  if (lifecycle.disposed || !data) return;
  graphMotion.setActive(true);
  saveCurrent();
  scopeFaction = factionById.has(faction) ? faction : null;
  navigate(byId.has(person) ? person : null, { replace, state, save: false });
}

function leaveGraph() {
  if (lifecycle.disposed) return;
  graphMotion.setActive(false);
  lifecycle.clearTimeout(historyTimer);
  saveCurrent();
  hidePreview();
  closePanel(true);
}

function createGroups() {
  const members = getEdges(focus).map(e => byId.get(other(e, focus))).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const grouped = new Map();
  for (const n of members) {
    if (!grouped.has(n.factionId)) grouped.set(n.factionId, []);
    grouped.get(n.factionId).push(n);
  }
  let result = [...grouped].map(([id, members]) => ({ id, name: factionById.get(id)?.name || members[0].factionName, members }));
  if (members.length > 36 && result.length > 6) {
    const major = result.filter(g => g.id !== 'rainbow').sort((a, b) => b.members.length - a.members.length).slice(0, 3).map(g => g.id);
    const keep = new Set([...major, 'rainbow']);
    const rest = result.filter(g => !keep.has(g.id));
    result = result.filter(g => keep.has(g.id));
    if (rest.length) result.push({ id: 'other', name: '其他阵营', members: rest.flatMap(g => g.members) });
  }
  const order = ['rhodes', 'yan', 'columbia', 'victoria', 'other', 'rainbow'];
  return result.sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 4) - (order.includes(b.id) ? order.indexOf(b.id) : 4));
}

function isExpanded(group) {
  return expanded.has('*') || expanded.has(group.id);
}

function memberLayout(members, cx, cy, compact = false) {
  const distance = compact ? 34 : 68;
  const radiusOffset = compact ? 16 : 32;
  return members.map((person, i) => {
    const theta = i * 2.3999632297;
    const radius = distance * Math.sqrt(i + 0.7);
    return {
      id: person.id,
      person,
      type: 'person',
      r: radiusOffset,
      x: cx + Math.cos(theta) * radius,
      y: cy + Math.sin(theta) * radius
    };
  });
}

function groupDetail() {
  const group = groups.find(g => g.id === groupView?.id);
  if (!group) return null;
  const members = group.members.filter(n => !groupView.faction || n.factionId === groupView.faction).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const small = svg.clientWidth < 600;
  const columns = small ? 2 : svg.clientHeight < 280 ? 4 : 6;
  const rows = Math.max(1, Math.min(small ? 2 : 3, Math.floor((svg.clientHeight - (small ? 120 : 90)) / (small ? 100 : 130))));
  const size = columns * rows;
  const pages = Math.max(1, Math.ceil(members.length / size));
  const page = Math.max(0, Math.min(groupView.page, pages - 1));
  return { members, size, columns, pages, page, start: page * size, layout: `${size}:${columns}:${small}`, name: factionById.get(groupView.faction)?.name || group.name };
}

function openGroup(id, { faction = null, member = null } = {}) {
  if (!groups.some(g => g.id === id) || getEdges(focus).length <= 36) return;
  if (!groupView) groupOverview = { expanded: [...expanded], coords: Object.fromEntries(positions), dragged: [...dragged], camera: { ...camera }, activeFaction, viewport: { ...renderedViewport } };
  groupView = { id, faction, page: 0 };
  const detail = groupDetail();
  if (member) groupView.page = Math.floor(Math.max(0, detail.members.findIndex(n => n.id === member)) / detail.size);
  positions.clear();
  dragged.clear();
  activeFaction = faction || (id === 'other' ? null : id);
  render({ fitView: true, motionKind: 'group' });
  $('#group-title').focus({ preventScroll: true });
  history.replaceState(snapshot(), '', location.href);
}

function closeGroup({ fitView = false, restoreFocus = true } = {}) {
  if (!groupView) return;
  const id = groupView.id;
  const previous = groupOverview;
  groupView = groupOverview = null;
  expanded = new Set(previous?.expanded || []);
  positions = new Map(Object.entries(previous?.coords || {}));
  dragged = new Set(previous?.dragged || []);
  activeFaction = previous?.activeFaction || null;
  if (previous?.camera) camera = { ...previous.camera };
  const resized = previous?.viewport?.width !== svg.clientWidth || previous?.viewport?.height !== svg.clientHeight;
  render({ fitView: fitView || !previous?.camera || resized });
  if (restoreFocus) (nodesLayer.querySelector(`[data-node="g:${CSS.escape(id)}"]`) || $('#view-title')).focus({ preventScroll: true });
  history.replaceState(snapshot(), '', location.href);
}

function changeGroupPage(delta) {
  if (!groupView) return;
  groupView.page += delta;
  positions.clear();
  dragged.clear();
  render({ fitView: true, motionKind: 'page' });
  $('#group-title').focus({ preventScroll: true });
  history.replaceState(snapshot(), '', location.href);
}

function layoutGroupDetail() {
  let detail = groupDetail();
  if (groupView.layout && groupView.layout !== detail.layout) {
    groupView.page = Math.floor(groupView.page * groupView.size / detail.size);
    positions.clear();
    dragged.clear();
    detail = groupDetail();
  }
  groupView.layout = detail.layout;
  groupView.size = detail.size;
  groupView.page = detail.page;
  const small = svg.clientWidth < 600;
  const short = svg.clientHeight < 280;
  const columns = detail.columns;
  const pageMembers = detail.members.slice(detail.start, detail.start + detail.size);
  const rows = Math.ceil(Math.min(detail.members.length, detail.size) / columns);
  visibleNodes[0] = { ...visibleNodes[0], r: small || short ? 44 : 66, x: small ? -125 : short ? -350 : -490, y: 0 };
  const rowCounts = small || short ? Array(rows).fill(columns) : rows === 3 ? [5, 7, 6] : rows === 2 ? [5, 7] : [6];
  pageMembers.forEach((person, i) => {
    let row = 0, column = i;
    while (column >= rowCounts[row]) column -= rowCounts[row++];
    // 错列留出姓名空间；实际漂浮位移由显示层控制，不参与历史坐标。
    const stagger = column % 2 ? -1 : 1;
    visibleNodes.push({
      id: person.id, person, type: 'person', group: groupView.id, r: 32,
      x: small ? -10 + column * 112 : short ? -160 + column * 116 : 136 + (column - (rowCounts[row] - 1) / 2) * 118 + Math.sin(column * 1.7 + row) * 10,
      y: (row - (rows - 1) / 2) * (small ? 112 : 124) + stagger * (small ? 8 : short ? 0 : 11) + (small || short ? 0 : Math.sin(column * 1.7 + row) * 7)
    });
  });
  const ids = new Set(pageMembers.map(n => n.id));
  visibleEdges.push(...getEdges(focus).filter(e => ids.has(other(e, focus))));
}

function layoutOverview() {
  groups = [];
  const ordered = data.factions.filter(faction => !scopeFaction || faction.id === scopeFaction).sort((a, b) => {
    const priority = ['rhodes', 'yan', 'columbia', 'victoria'];
    const ai = priority.indexOf(a.id), bi = priority.indexOf(b.id);
    return (ai < 0 ? 20 : ai) - (bi < 0 ? 20 : bi) || a.order - b.order;
  });
  const packed = [];
  for (const faction of ordered) {
    const members = data.nodes.filter(n => n.factionId === faction.id);
    // 低高度横屏将单阵营铺成横向点阵，避免圆形布局被高度压成不可点击的小团。
    if (scopeFaction && compactLandscape.matches) {
      const aspect = Math.max(1, svg.clientWidth / Math.max(1, svg.clientHeight));
      const columns = Math.min(members.length, Math.ceil(Math.sqrt(members.length * aspect)));
      const rows = Math.ceil(members.length / columns), gap = 52;
      const rx = (columns - 1) * gap / 2 + 38, ry = (rows - 1) * gap / 2 + 50;
      regions.push({ id: faction.id, name: faction.name, count: members.length, x: 0, y: 0, r: rx, rx, ry, overview: true });
      visibleNodes.push(...members.map((person, index) => ({
        id: person.id, person, type: 'person', r: 22,
        x: (index % columns - (columns - 1) / 2) * gap,
        y: (Math.floor(index / columns) - (rows - 1) / 2) * gap
      })));
      continue;
    }
    const r = Math.max(95, 34 * Math.sqrt(members.length) + 48);
    let x = 0, y = 0, found = false;
    if (packed.length) {
      for (let j = 0; j < 6000; j++) {
        const angle = j * 0.15, dist = 50 + angle * 17;
        x = Math.cos(angle) * dist;
        y = Math.sin(angle) * dist * 0.78;
        if (packed.every(p => Math.hypot(x - p.x, y - p.y) > r + p.r + 56)) {
          found = true;
          break;
        }
      }
    }
    if (packed.length && !found) {
      x = packed.length * 650;
      y = 0;
    }
    packed.push({ x, y, r });
    regions.push({ id: faction.id, name: faction.name, count: members.length, x, y, r, overview: true });
    visibleNodes.push(...memberLayout(members, x, y, true));
  }
  const keys = new Set(visibleNodes.map(n => n.id));
  for (const edge of data.edges) {
    if (keys.has(edge.source) && keys.has(edge.target)) {
      visibleEdges.push({ ...edge });
    }
  }
}

function layoutFocus() {
  groups = createGroups();
  visibleNodes.push({ id: focus, person: byId.get(focus), type: 'person', center: true, r: 80, x: 0, y: 0 });
  const degree = getEdges(focus).length;

  if (groupView && groupDetail()) {
    layoutGroupDetail();
  } else if (degree <= 36) {
    const people = getEdges(focus).map(e => byId.get(other(e, focus)));
    for (let i = 0; i < people.length; i++) {
      const ring = i < 12 ? 0 : 1;
      const start = ring ? 12 : 0, count = Math.min(ring ? 24 : 12, people.length - start);
      const angle = -Math.PI / 2 + (i - start) * Math.PI * 2 / count;
      const radius = ring ? 380 : 240;
      visibleNodes.push({ id: people[i].id, person: people[i], type: 'person', r: 32, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    visibleEdges.push(...getEdges(focus));
  } else {
    const count = groups.length;
    const packed = [];
    const center = dragged.has(focus) ? positions.get(focus) : { x: 0, y: 0 };
    groups.forEach((group, i) => {
      const open = isExpanded(group);
      const local = memberLayout(group.members, 0, 0);
      const r = open ? Math.max(140, ...local.map(n => Math.hypot(n.x, n.y) + n.r + 48)) : 88;
      const key = `g:${group.id}`;
      const previous = positions.get(key);
      const remembered = dragged.has(key) && previous;
      const angle = remembered ? Math.atan2(remembered.y - center.y, remembered.x - center.x) : (i / count) * Math.PI * 2 - Math.PI / 2;
      let dist = remembered ? Math.hypot(remembered.x - center.x, remembered.y - center.y) : open ? 180 + r : window.innerWidth <= 700 || compactLandscape.matches ? 250 : 320;
      let x = remembered ? remembered.x : center.x + Math.cos(angle) * dist, y = remembered ? remembered.y : center.y + Math.sin(angle) * dist;

      for (let tries = 0; tries < 600; tries++) {
        const centerClearance = Math.hypot(x - center.x, y - center.y) >= (144 + r);
        const clusterClearance = packed.every(p => Math.hypot(x - p.x, y - p.y) >= (r + p.r + 64));
        if (centerClearance && clusterClearance) break;
        dist += 30;
        x = center.x + Math.cos(angle) * dist;
        y = center.y + Math.sin(angle) * dist;
      }
      // 自动点位随组框一起重排；仅保留用户拖动，避免旧缓存把人物留在空组框外。
      for (const n of local) {
        const custom = dragged.has(n.id) && positions.get(n.id);
        positions.set(n.id, custom && previous ? { x: custom.x + x - previous.x, y: custom.y + y - previous.y } : { x: n.x + x, y: n.y + y });
      }
      positions.set(key, { x, y });
      packed.push({ x, y, r });
      group.anchor = { x, y };

      if (open) {
        regions.push({ id: group.id, name: group.name, count: group.members.length, x, y, r, overview: false });
        for (const n of local) {
          visibleNodes.push({ ...n, x: n.x + x, y: n.y + y, group: group.id });
        }
        for (const member of group.members) {
          const edge = getEdges(focus).find(e => other(e, focus) === member.id);
          if (edge) visibleEdges.push({ ...edge });
        }
      } else {
        visibleNodes.push({ id: `g:${group.id}`, type: 'group', group, person: null, r: 88, x, y });
        visibleEdges.push({ id: `summary:${group.id}`, source: focus, target: `g:${group.id}`, aggregate: true, group: group.id });
      }
    });
  }

  if (neighbors) {
    const ids = new Set(visibleNodes.filter(n => n.type === 'person').map(n => n.id));
    for (const edge of data.edges) {
      if (edge.source !== focus && edge.target !== focus && ids.has(edge.source) && ids.has(edge.target)) {
        visibleEdges.push({ ...edge, neighbor: true });
      }
    }
  }
}

function currentPoint(id) {
  return positions.get(id) || visibleNodes.find(n => n.id === id) || { x: 0, y: 0 };
}

function nodeMarkup(n) {
  const p = currentPoint(n.id);
  const group = n.type === 'group';
  const inside = group ? `
    <g class="node-bubble">
      <circle class="group-ambient-ring" r="${n.r + 8}"/>
      <circle class="group-bubble-body" r="${n.r}"/>
    </g>
    <text class="group-name" text-anchor="middle" y="-16">${esc(n.group.name)}</text>
    <text class="group-count" text-anchor="middle" y="14">${n.group.members.length} 人</text>
    <path class="group-plus" d="M-8 43H8M0 35V51"/>
  ` : `
    <g class="node-bubble">
      <circle class="bubble-sphere-base" r="${n.r}"/>
      <text class="avatar-monogram" aria-hidden="true">${esc(n.person.name[0])}</text>
      <image href="${avatar(n.id)}" x="${-n.r + 2}" y="${-n.r + 2}" width="${n.r * 2 - 4}" height="${n.r * 2 - 4}" clip-path="url(#clip-${n.id})" preserveAspectRatio="xMidYMid slice" pointer-events="none"/>
      <circle class="bubble-glass-rim" r="${n.r + 1}"/>
      ${n.center ? `<circle class="center-orbit-dash" r="${n.r + 9}"/>` : ''}
    </g>
    <text class="name ${n.center ? 'center-label' : ''}" text-anchor="middle" y="${n.r + (n.center ? 32 : 22)}">${esc(groupView && !n.center && [...n.person.name].length > 7 ? [...n.person.name].slice(0, 7).join('') + '…' : n.person.name)}</text>
  `;
  return `<g class="graph-node ${group ? 'group-node' : 'person-node'} ${n.center ? 'center-node' : ''}" data-node="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(group ? n.group.name + '，' + n.group.members.length + '人，查看分组' : n.person.name + '，查看关系')}" transform="translate(${p.x} ${p.y})">${inside}</g>`;
}

function render({ fitView = false, motionKind = 'layout' } = {}) {
  if (!data) return;
  const previousDisplay = graphMotion.capture();
  hidePreview();
  highlightEdges(null);
  renderSequence++;
  visibleNodes = [];
  visibleEdges = [];
  regions = [];
  if (focus) layoutFocus();
  else layoutOverview();
  $('#graph-stage').classList.toggle('compact-overview', !focus && !!scopeFaction && compactLandscape.matches);
  $('#graph-stage').classList.toggle('group-detail', !!groupView);

  for (const n of visibleNodes) {
    if (!positions.has(n.id) || (!dragged.has(n.id) && (groupView || !focus || getEdges(focus).length <= 36 || n.center))) positions.set(n.id, { x: n.x, y: n.y });
  }

  svg.removeAttribute('viewBox');
  $('#graph-defs').innerHTML = visibleNodes.filter(n => n.type === 'person').map(n => `<clipPath id="clip-${n.id}"><circle r="${n.r - 2}"/></clipPath>`).join('');

  regionsLayer.innerHTML = regions.map(r => `<g data-region="${esc(r.id)}">${r.rx
    ? `<rect class="region-outline" x="${r.x - r.rx}" y="${r.y - r.ry}" width="${r.rx * 2}" height="${r.ry * 2}"/>`
    : `<circle class="region-outline" cx="${r.x}" cy="${r.y}" r="${r.r}"/>`}<text class="region-name" text-anchor="middle" x="${r.x}" y="${r.y - (r.ry || r.r) + (r.ry ? 18 : 26)}">${esc(r.name)} · ${r.count}人</text>${r.overview ? `<text class="region-caption" text-anchor="middle" x="${r.x}" y="${r.y - (r.ry || r.r) + 44}">${esc(r.id.toUpperCase())}</text>` : `<text class="region-collapse" role="button" tabindex="0" data-collapse="${esc(r.id)}" text-anchor="middle" x="${r.x}" y="${r.y + r.r + 24}" aria-label="收起${esc(r.name)}">收起</text>`}</g>`).join('');
  edgesLayer.classList.toggle('overview', !focus);
  edgesLayer.innerHTML = visibleEdges.map(e => {
    const a = currentPoint(e.source), b = currentPoint(e.target);
    const { d } = curveBetween(a, b);
    return `<g data-edge-group="${esc(e.id)}">${!e.aggregate ? `<path class="edge-hit" data-edge="${esc(e.id)}" d="${d}"/>` : ''}<path class="edge-line ${e.aggregate ? 'aggregate' : ''}" data-source="${esc(e.source)}" data-target="${esc(e.target)}" d="${d}" pointer-events="none"/></g>`;
  }).join('');
  nodesLayer.innerHTML = visibleNodes.map(nodeMarkup).join('');

  const person = byId.get(focus);
  const degree = person ? getEdges(focus).length : 0;
  const faction = factionById.get(scopeFaction);
  $('#view-title').textContent = person ? person.name : faction?.name || '阵营总览';
  $('#view-subtitle').textContent = person ? `${degree} 位关联人物 · 包含跨阵营关系` : `${visibleNodes.length} 位人物 · ${visibleEdges.length.toLocaleString()} 条${faction ? '阵营内' : ''}关系`;
  $('#view-context').textContent = person?.factionName || (faction ? '阵营关系图' : '全部阵营');
  $('#stage-caption').textContent = finePointer.matches ? '悬停人物显示关系 · 点击连线查看原文' : '点击人物查看关系 · 名录中可查阅原文';
  $('#group-browser').hidden = !groupView;
  if (groupView) {
    const detail = groupDetail();
    $('#group-title').textContent = detail.name;
    $('#group-range').textContent = `${detail.start + 1}–${Math.min(detail.start + detail.size, detail.members.length)} / ${detail.members.length} 人`;
    $('#group-prev').disabled = groupView.page === 0;
    $('#group-next').disabled = groupView.page >= detail.pages - 1;
  }
  $('#neighbors-label').hidden = !focus;
  $('#neighbors').checked = neighbors;
  $('#expand-all').hidden = !focus || degree <= 36;
  $('#collapse-all').hidden = !focus || degree <= 36;
  $('#open-list').innerHTML = '<svg><use href="#i-list"/></svg><span>' + (focus ? '关系名录' : '人物名录') + '</span>';
  $('#back span').textContent = '返回';
  $('#empty-state').hidden = !(focus && degree === 0);
  $('#empty-state').innerHTML = focus && degree === 0 ? '当前资料尚未记录此人物的关系。可搜索其他人物继续探索。' : '';

  const allCount = focus ? getEdges(focus).map(e => byId.get(other(e, focus))) : data.nodes;
  const selectedFaction = focus ? activeFaction : scopeFaction;
  $('#factions').innerHTML = `<button class="faction-button ${!selectedFaction ? 'active' : ''}" aria-pressed="${!selectedFaction}" data-faction="all"><span class="faction-name">全部阵营</span><span class="faction-count">${allCount.length}</span></button>` + data.factions.map(f => {
    const count = allCount.filter(n => n.factionId === f.id).length;
    return count ? `<button class="faction-button ${selectedFaction === f.id ? 'active' : ''}" aria-pressed="${selectedFaction === f.id}" data-faction="${esc(f.id)}"><span class="faction-name">${esc(f.name)}</span><span class="faction-count">${count}</span></button>` : '';
  }).join('');
  $('#operator-shortcuts').querySelectorAll('[data-shortcut]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.shortcut === focus)));

  if (fitView) fit();
  else applyCamera();
  graphMotion.mount(visibleNodes, visibleEdges, previousDisplay, motionKind);
  graphMotion.setEdges(showAllLines);
  renderedViewport = { width: svg.clientWidth, height: svg.clientHeight };
}

function toggleGroup(id, open) {
  if (groupView) closeGroup({ restoreFocus: false });
  const group = groups.find(g => g.id === id);
  if (!group) return;
  const was = isExpanded(group);
  if (expanded.has('*')) {
    expanded = new Set(groups.map(g => g.id));
  }
  if (open ?? !was) expanded.add(id);
  else expanded.delete(id);

  render({ fitView: true });
  history.replaceState(snapshot(), '', location.href);
}

function locate(id) {
  if (!byId.has(id)) return;
  if (!focus) {
    if (scopeFaction && byId.get(id).factionId !== scopeFaction) {
      navigate(id);
      return;
    }
    const node = visibleNodes.find(n => n.id === id);
    if (node) fit([{ ...node, r: 170 }]);
    highlightNode(id);
    return;
  }
  if (id !== focus && !getEdges(focus).some(e => other(e, focus) === id)) {
    navigate(id);
    return;
  }
  const group = groups.find(g => g.members.some(n => n.id === id));
  if (group && getEdges(focus).length > 36) {
    openGroup(group.id, { member: id, faction: groupView?.faction === byId.get(id).factionId ? groupView.faction : null });
    highlightNode(id);
    return;
  }
  if (group && !isExpanded(group)) {
    expanded.add(group.id);
    render();
  }
  const target = visibleNodes.find(n => n.id === id);
  if (target) {
    const a = visibleNodes.find(n => n.id === focus);
    fit([a, target]);
    highlightNode(id);
  }
  history.replaceState(snapshot(), '', location.href);
}

function highlightNode(id) {
  const el = nodesLayer.querySelector(`[data-node="${id}"]`);
  el?.classList.add('located');
  lifecycle.timeout(() => el?.classList.remove('located'), 2400);
}

function selectFaction(id) {
  if (!focus) {
    enterGraph(id === 'all' ? null : id);
    return;
  }
  if (getEdges(focus).length > 36) {
    if (id === 'all') {
      closeGroup({ restoreFocus: false });
      activeFaction = null;
      render({ fitView: true });
      history.replaceState(snapshot(), '', location.href);
    } else {
      const group = groups.find(g => g.members.some(n => n.factionId === id));
      if (group) openGroup(group.id, { faction: id });
    }
    return;
  }
  activeFaction = id === 'all' ? null : id;
  if (id === 'all') {
    render({ fitView: true });
    return;
  }
  if (!focus) {
    const reg = regions.find(r => r.id === id);
    if (reg) fit([{ ...reg, id: 'region-select' }]);
  } else {
    const group = groups.find(g => g.id === id || g.members.some(n => n.factionId === id));
    if (group && !isExpanded(group)) {
      expanded.add(group.id);
      render();
    }
    const selected = visibleNodes.filter(n => n.person?.factionId === id);
    if (selected.length) fit(selected);
  }
  root.querySelectorAll('[data-faction]').forEach(button => {
    button.classList.toggle('active', button.dataset.faction === id);
    button.setAttribute('aria-pressed', String(button.dataset.faction === id));
  });
  history.replaceState(snapshot(), '', location.href);
}

function moveNode(id, p) {
  if (id.startsWith('g:')) {
    const before = currentPoint(id);
    for (const member of groups.find(g => g.id === id.slice(2))?.members || []) {
      const existing = positions.get(member.id);
      if (existing) positions.set(member.id, { x: existing.x + p.x - before.x, y: existing.y + p.y - before.y });
    }
  }
  dragged.add(id);
  positions.set(id, p);
  graphMotion.move(id);
}

lifecycle.listen(svg, 'pointerdown', event => {
  if (!data) return;
  hidePreview();
  if (event.button !== 0) return;
  const p = point(event);
  pointers.set(event.pointerId, p);
  svg.setPointerCapture(event.pointerId);
  const node = event.target.closest('[data-node]');
  gesture = {
    pointer: event.pointerId,
    start: p,
    startCamera: { ...camera },
    node: node?.dataset.node,
    initial: node ? graphMotion.point(node.dataset.node) : null,
    last: { ...p, time: event.timeStamp }, velocity: { x: 0, y: 0 },
    moved: false,
    target: event.target
  };
  if (pointers.size === 2) {
    graphMotion.release(graphMotion.dragged);
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), camera: { ...camera }, anchor: toWorld(mid) };
    gesture.moved = true;
  }
  event.preventDefault();
});

lifecycle.listen(svg, 'pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  const p = point(event);
  pointers.set(event.pointerId, p);
  if (pointers.size >= 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    camera.k = Math.min(3, Math.max(0.1, pinch.camera.k * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance)));
    camera.x = mid.x - pinch.anchor.x * camera.k;
    camera.y = mid.y - pinch.anchor.y * camera.k;
    applyCamera();
    return;
  }
  if (!gesture || gesture.pointer !== event.pointerId) return;
  const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
  if (Math.hypot(dx, dy) > 4) gesture.moved = true;
  if (!gesture.moved) return;
  svg.classList.add('dragging');
  const elapsed = Math.max(1, event.timeStamp - gesture.last.time);
  gesture.velocity = { x: (p.x - gesture.last.x) / elapsed, y: (p.y - gesture.last.y) / elapsed };
  gesture.last = { ...p, time: event.timeStamp };
  if (gesture.node) {
    graphMotion.beginDrag(gesture.node);
    moveNode(gesture.node, { x: gesture.initial.x + dx / camera.k, y: gesture.initial.y + dy / camera.k });
  }
  else {
    camera.x = gesture.startCamera.x + dx;
    camera.y = gesture.startCamera.y + dy;
    applyCamera();
  }
});

function finishPointer(event, cancelled = false) {
  pointers.delete(event.pointerId);
  svg.classList.remove('dragging');
  if (pinch) {
    pinch = null;
    gesture = null;
    return;
  }
  const g = gesture;
  gesture = null;
  if (!g || g.pointer !== event.pointerId) return;
  if (g.node && g.moved) graphMotion.release(g.node, g.velocity);
  if (!cancelled && !g.moved) {
    const collapse = g.target.closest('[data-collapse]'), edge = g.target.closest('[data-edge]');
    if (collapse) toggleGroup(collapse.dataset.collapse, false);
    else if (g.node) {
      if (g.node.startsWith('g:')) openGroup(g.node.slice(2));
      else if (g.node !== focus) navigate(g.node);
    } else if (edge) showEdge(edge.dataset.edge);
  } else history.replaceState(snapshot(), '', location.href);
}

lifecycle.listen(svg, 'pointerup', event => finishPointer(event));
lifecycle.listen(svg, 'pointercancel', event => finishPointer(event, true));
lifecycle.listen(svg, 'wheel', event => {
  event.preventDefault();
  zoom(Math.exp(-event.deltaY * 0.001), point(event));
}, { passive: false });

lifecycle.listen(svg, 'keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const node = event.target.closest('[data-node]'), collapse = event.target.closest('[data-collapse]');
  if (node) {
    event.preventDefault();
    node.dataset.node.startsWith('g:') ? openGroup(node.dataset.node.slice(2)) : navigate(node.dataset.node);
  } else if (collapse) {
    event.preventDefault();
    toggleGroup(collapse.dataset.collapse, false);
  }
});

function highlightEdges(id) {
  lifecycle.clearTimeout(edgeClearTimer);
  hovered = id || null;
  graphMotion.hover(hovered);
  edgesLayer.classList.toggle('highlighting', !!hovered);
  edgesLayer.querySelectorAll('.edge-highlight').forEach(el => el.classList.remove('edge-highlight'));
  edgesLayer.querySelectorAll('.edge-active').forEach(el => el.classList.remove('edge-active'));
  if (hovered) edgesLayer.querySelectorAll(`[data-source="${CSS.escape(hovered)}"],[data-target="${CSS.escape(hovered)}"]`).forEach(el => { el.classList.add('edge-highlight'); el.parentElement.classList.add('edge-active'); });
  graphMotion.setEdges(showAllLines, hovered);
}
lifecycle.listen(svg, 'pointerover', event => {
  if (pointers.size) return;
  lifecycle.clearTimeout(edgeClearTimer);
  const id = event.target.closest('[data-node]')?.dataset.node;
  if (id && id !== hovered) highlightEdges(id);
  else if (!id && !event.target.closest('[data-edge-group]')) edgeClearTimer = lifecycle.timeout(() => highlightEdges(null), 400);
});

function hidePreview() {
  lifecycle.cancelFrame(previewFrame);
  if (previewNode) previewNode.removeAttribute('aria-describedby');
  previewNode = null;
  previewTarget = previewPosition = null;
  $('#node-preview').hidden = true;
}

function movePreview() {
  if (!previewTarget) return;
  const dx = previewTarget.x - previewPosition.x, dy = previewTarget.y - previewPosition.y;
  if (motionPreference.matches || Math.abs(dx) + Math.abs(dy) < .8) previewPosition = { ...previewTarget };
  else { previewPosition.x += dx * .24; previewPosition.y += dy * .24; }
  $('#node-preview').style.transform = `translate(${previewPosition.x}px, ${previewPosition.y}px)`;
  if (previewPosition.x !== previewTarget.x || previewPosition.y !== previewTarget.y) previewFrame = lifecycle.frame(movePreview);
}

function showPreview(node, x, y) {
  const person = byId?.get(node?.dataset.node);
  if (!person || pointers.size || $('#panel').open) { hidePreview(); return; }
  const preview = $('#node-preview');
  if (previewNode !== node) {
    previewNode?.removeAttribute('aria-describedby');
    previewNode = node;
    node.setAttribute('aria-describedby', 'node-preview');
    preview.innerHTML = `<img src="${avatar(person.id)}" alt=""><div class="preview-copy"><strong>${esc(person.name)}</strong><span>${esc(person.factionName)} · ${getEdges(person.id).length} 位关联人物</span><small>点击展开完整关系</small></div>`;
  }
  preview.hidden = false;
  previewTarget = { x: Math.max(8, Math.min(x + 20, svg.clientWidth - 230)), y: Math.max(8, Math.min(y + 18, svg.clientHeight - 100)) };
  previewPosition ||= { ...previewTarget };
  lifecycle.cancelFrame(previewFrame);
  movePreview();
}

lifecycle.listen(svg, 'pointermove', event => {
  if (!finePointer.matches || event.pointerType !== 'mouse') return;
  const p = point(event);
  if (!pointers.size) graphMotion.hover(event.target.closest('[data-node]')?.dataset.node);
  showPreview(event.target.closest('[data-node]'), p.x, p.y);
});
lifecycle.listen(svg, 'pointerleave', () => { hidePreview(); highlightEdges(null); });
lifecycle.listen(svg, 'focusin', event => {
  const node = event.target.closest('[data-node]');
  highlightEdges(node?.dataset.node);
  if (!finePointer.matches) return;
  if (!node) return;
  const rect = node.getBoundingClientRect(), stage = svg.getBoundingClientRect();
  showPreview(node, rect.x + rect.width / 2 - stage.x, rect.y + rect.height / 2 - stage.y);
});
lifecycle.listen(svg, 'focusout', () => { hidePreview(); highlightEdges(null); });

lifecycle.listen(document, 'error', event => {
  if (event.target instanceof HTMLImageElement || event.target instanceof SVGImageElement) event.target.classList.add('avatar-failed');
}, true);

function updateShortcutArrows() {
  const strip = $('#operator-shortcuts');
  $('#operators-prev').disabled = strip.scrollLeft < 2;
  $('#operators-next').disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
}
lifecycle.listen($('#operator-shortcuts'), 'click', event => {
  const button = event.target.closest('[data-shortcut]');
  if (button) navigate(button.dataset.shortcut);
});
lifecycle.listen($('#operator-shortcuts'), 'scroll', updateShortcutArrows, { passive: true });
lifecycle.observe(ResizeObserver, $('#operator-shortcuts'), updateShortcutArrows);
for (const [id, direction] of [['operators-prev', -1], ['operators-next', 1]]) {
  lifecycle.handler($('#' + id), 'onclick', () => $('#operator-shortcuts').scrollBy({ left: direction * $('#operator-shortcuts').clientWidth * .8, behavior: motionPreference.matches ? 'instant' : 'smooth' }));
}

lifecycle.listen(motionPreference, 'change', () => {
  viewAnimations.forEach(animation => animation.cancel());
  if ($('#panel').open && panelClosing) closePanel(true);
  else panelAnimation?.cancel();
  hidePreview();
  syncGraphMotion();
});

function syncGraphMotion() {
  const enabled = !motionPaused && !motionPreference.matches;
  graphMotion.setEnabled(enabled);
  $('#graph-motion').checked = enabled;
  $('#graph-motion').disabled = motionPreference.matches;
  $('#graph-motion').closest('label').title = motionPreference.matches ? '已跟随系统减少动态' : '';
}
lifecycle.handler($('#graph-motion'), 'onchange', event => {
  motionPaused = !event.target.checked;
  try { localStorage.setItem('atlas:graph-motion', motionPaused ? 'paused' : 'playing'); } catch { /* 不依赖存储完成当前操作。 */ }
  syncGraphMotion();
});
lifecycle.handler($('#show-lines'), 'onchange', event => {
  showAllLines = event.target.checked;
  edgesLayer.classList.toggle('lines-visible', showAllLines);
  graphMotion.setEdges(showAllLines, hovered);
});
syncGraphMotion();

function openPanel(mode) {
  panelEvents.dispose();
  panelEvents = createLifecycle();
  const panel = $('#panel');
  const opening = !panel.open;
  if (opening) lastFocus = document.activeElement;
  panelAnimation?.cancel();
  panelClosing = false;
  hidePreview();
  panelMode = mode;
  if (opening) panel.showModal();
  // 面板内部换内容时保留固定顶栏，不再次对整个顶层弹窗做合成动画。
  if (opening && !motionPreference.matches) {
    const mobile = matchMedia('(max-width: 760px)').matches;
    panelAnimation = lifecycle.animate(panel, [{ opacity: .4, transform: mobile ? 'translateY(30px)' : 'translateX(36px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }
  panel.scrollTop = 0;
  $('#panel-content').scrollTop = 0;
  $('#close-panel').focus({ preventScroll: true });
}

function closePanel(immediate = false) {
  panelEvents.dispose();
  const panel = $('#panel');
  panelMode = null;
  if (!panel.open || (panelClosing && !immediate)) return;
  panelAnimation?.cancel();
  const finish = () => {
    panelClosing = false;
    panel.close();
    const target = lastFocus?.isConnected && !panel.contains(lastFocus) ? lastFocus : $('#view-title');
    target?.focus?.({ preventScroll: true });
  };
  if (immediate || motionPreference.matches) { finish(); return; }
  panelClosing = true;
  panelAnimation = lifecycle.animate(panel, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: matchMedia('(max-width: 760px)').matches ? 'translateY(20px)' : 'translateX(24px)' }], { duration: 180, easing: 'ease-in' });
  panelAnimation.onfinish = finish;
}

lifecycle.listen($('#panel'), 'cancel', event => { event.preventDefault(); closePanel(); });
lifecycle.listen($('#panel'), 'keydown', event => {
  if (event.key !== 'Tab') return;
  const items = [...$('#panel').querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex="0"]')].filter(element => element.getClientRects().length);
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
lifecycle.listen($('#panel'), 'click', event => {
  if (event.target !== $('#panel')) return;
  const rect = $('#panel').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePanel();
});

async function loadEvidence(id) {
  return lifecycle.json('/api/relationships/' + encodeURIComponent(id) + '/');
}

async function showEdge(id) {
  if (lifecycle.disposed) return;
  const edge = byEdge.get(id);
  if (!edge) return;
  const a = byId.get(edge.source), b = byId.get(edge.target);
  const isMutual = edge.kind === 'mutual';
  const statusLabel = isMutual ? '双方相识' : '单向知晓';

  openPanel('edge:' + id);
  $('#panel-content').innerHTML = `
    <div class="panel-header-title">
      <h2>关系档案</h2>
      <span class="dossier-id">RECORD // ${esc(edge.id)}</span>
    </div>

    <div class="dossier-versus">
      <button class="dossier-operator" data-navigate="${esc(a.id)}" title="切换至 ${esc(a.name)}">
        <img src="${avatar(a.id)}" alt="${esc(a.name)}">
        <span class="dossier-op-name">${esc(a.name)}</span>
        <span class="dossier-op-faction">${esc(a.factionName)}</span>
      </button>

      <div class="dossier-relation-flow">
        <span class="flow-badge ${isMutual ? 'flow-mutual' : 'flow-awareness'}">${esc(statusLabel)}</span>
        <div class="flow-arrow">
          ${isMutual
            ? '<svg width="48" height="12" viewBox="0 0 48 12"><line x1="2" y1="6" x2="46" y2="6" stroke="currentColor" stroke-width="2"/><circle cx="5" cy="6" r="3" fill="currentColor"/><circle cx="43" cy="6" r="3" fill="currentColor"/></svg>'
            : (edge.from === a.id
              ? '<svg width="48" height="12" viewBox="0 0 48 12"><line x1="2" y1="6" x2="42" y2="6" stroke="currentColor" stroke-width="2"/><polygon points="42,2 48,6 42,10" fill="currentColor"/><circle cx="4" cy="6" r="3" fill="currentColor"/></svg>'
              : '<svg width="48" height="12" viewBox="0 0 48 12"><line x1="6" y1="6" x2="46" y2="6" stroke="currentColor" stroke-width="2"/><polygon points="6,2 0,6 6,10" fill="currentColor"/><circle cx="44" cy="6" r="3" fill="currentColor"/></svg>'
            )
          }
        </div>
      </div>

      <button class="dossier-operator" data-navigate="${esc(b.id)}" title="切换至 ${esc(b.name)}">
        <img src="${avatar(b.id)}" alt="${esc(b.name)}">
        <span class="dossier-op-name">${esc(b.name)}</span>
        <span class="dossier-op-faction">${esc(b.factionName)}</span>
      </button>
    </div>

    ${!isMutual ? `<div class="dossier-status-desc">记录支持 <strong>${esc(byId.get(edge.from)?.name)}</strong> 知晓 <strong>${esc(byId.get(edge.to)?.name)}</strong>，但尚不能认定双方彼此相识。</div>` : ''}

    <button class="member-btn member-btn-accent record-community-button" data-community="relationship" data-target="${esc(id)}">查看关系档案</button>
    <div id="evidence-body">
      <p style="color: var(--text-muted); font-size: 13px;">正在读取原文依据…</p>
    </div>
  `;

  try {
    const evidence = await loadEvidence(id);
    if (lifecycle.disposed || panelMode !== 'edge:' + id) return;
    if (!evidence) throw new Error('Missing evidence');
    const sources = evidence.sources || [];

    $('#evidence-body').innerHTML = `
      <div class="evidence-section">
        <span class="section-label">关键剧情原文依据</span>
        <blockquote class="dossier-quote">${esc(evidence.quote || '本条关系核定依据见判定说明。')}</blockquote>
      </div>

      <details class="evidence-accordion" open>
        <summary>判定说明</summary>
        <div class="evidence-accordion-content">
          <p>${esc(evidence.note || '暂无补充说明。')}</p>
        </div>
      </details>

      <details class="evidence-accordion" ${sources.length > 0 ? 'open' : ''}>
        <summary>来源出处 (${sources.length})</summary>
        <div class="evidence-accordion-content">
          ${sources.length ? renderSources(sources) : '<p style="color: var(--text-muted); font-size: 12px;">来源标注已包含在关键原文中。</p>'}
        </div>
      </details>
    `;
  } catch {
    if (panelMode === 'edge:' + id) {
      $('#evidence-body').innerHTML = `
        <p style="color: var(--text-muted); font-size: 13px;">原文档案读取失败。</p>
        <button class="member-btn member-btn-accent" style="margin-top: 8px;" data-retry="${esc(id)}">重新读取</button>
      `;
    }
  }
}

function listMembers(query = '') {
  const members = focus
    ? getEdges(focus).map(edge => ({ person: byId.get(other(edge, focus)), edge }))
    : data.nodes.filter(person => !scopeFaction || person.factionId === scopeFaction).map(person => ({ person }));
  const q = query.trim().toLowerCase();
  return members.filter(({ person, edge }) => (!listIds || listIds.has(person.id)) && (!focus || listKind === 'all' || edge?.kind === listKind) && (!q || [person.name, person.factionName, ...person.aliases].some(x => x.toLowerCase().includes(q)))).sort((a, b) => a.person.name.localeCompare(b.person.name, 'zh-CN'));
}

function fillMemberList(query = '') {
  const members = listMembers(query);
  $('#member-list').innerHTML = members.map(({ person, edge }) => `
    <div class="member-row">
      <img src="${avatar(person.id)}" alt="${esc(person.name)}" loading="lazy">
      <button class="member-main" data-navigate="${person.id}" title="查看 ${esc(person.name)}">
        <span class="member-name">${esc(person.name)}</span>
        <span class="member-faction">${esc(person.factionName)}</span>
      </button>
      <div class="member-actions">
        <button class="member-btn" data-locate="${person.id}" aria-label="在图谱中定位">定位</button>
        ${edge ? `<button class="member-btn member-btn-accent" data-detail="${esc(edge.id)}" aria-label="查看详情">详情</button>` : ''}
      </div>
    </div>
  `).join('') || '<p style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">未找到符合条件的人物。</p>';

  $('#member-count').textContent = `${members.length} 位人物`;
  $('#member-list').querySelectorAll('img').forEach(image => image.addEventListener('error', () => image.style.visibility = 'hidden', { once: true }));
}

function showList({ groupOnly = false } = {}) {
  const detail = groupOnly && groupView ? groupDetail() : null;
  listIds = detail ? new Set(detail.members.map(n => n.id)) : null;
  listKind = 'all';
  openPanel('list');
  $('#panel-content').innerHTML = `
    <div class="panel-header-title">
      <h2>${focus ? esc(byId.get(focus).name) + ' 的关系名录' : scopeFaction ? esc(factionById.get(scopeFaction).name) + ' · 人物名录' : '全部人物名录'}${detail ? ' · ' + esc(detail.name) : ''}</h2>
      <span id="member-count" class="dossier-id"></span>
    </div>
    <div class="panel-search-wrap">
      <svg class="panel-search-icon" aria-hidden="true"><use href="#i-search"/></svg>
      <input id="member-search" class="panel-search-box" placeholder="搜索代号、真名或阵营..." aria-label="在名单中查找">
    </div>
    ${focus ? '<div class="relation-tabs" role="tablist" aria-label="关系类型"><button id="tab-all" class="relation-tab" role="tab" aria-controls="member-list" aria-selected="true" data-kind="all">全部关系</button><button id="tab-mutual" class="relation-tab" role="tab" aria-controls="member-list" aria-selected="false" tabindex="-1" data-kind="mutual">双方相识</button><button id="tab-awareness" class="relation-tab" role="tab" aria-controls="member-list" aria-selected="false" tabindex="-1" data-kind="awareness">单向知晓</button></div>' : ''}
    <div id="member-list" class="member-list-wrap" ${focus ? 'role="tabpanel" aria-labelledby="tab-all" tabindex="0"' : ''}></div>
  `;
  fillMemberList();
  panelEvents.listen($('#member-search'), 'input', event => fillMemberList(event.target.value));
  panelEvents.listen($('.relation-tabs'), 'click', event => {
    const tab = event.target.closest('[data-kind]');
    if (!tab) return;
    listKind = tab.dataset.kind;
    $('.relation-tabs').querySelectorAll('[role="tab"]').forEach(item => {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    $('#member-list').setAttribute('aria-labelledby', tab.id);
    fillMemberList($('#member-search').value);
    if (!motionPreference.matches) lifecycle.animate($('#member-list'), [{ opacity: .4, transform: 'translateX(8px)' }, { opacity: 1, transform: 'none' }], { duration: 180 });
  });
  panelEvents.listen($('.relation-tabs'), 'keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...$('.relation-tabs').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus(); tabs[next].click();
  });
}

function showHelp() {
  openPanel('help');
  $('#panel-content').innerHTML = `
    <div class="panel-header-title">
      <h2>操作指南</h2>
      <span class="dossier-id">MANUAL // PRTS</span>
    </div>
    <div class="help-guide">
      <div class="guide-block">
        <h3>关系探索</h3>
        <p>点击任意干员头像切换至其中心视角。左侧阵营索引与顶部搜索支持快速定位。</p>
      </div>
      <div class="guide-block">
        <h3>阵营聚合</h3>
        <p>关联人物较多时先按阵营分组。点击分组可单独查看，使用上一页、下一页或“本组名录”查找成员；“全部分组”回到原视角。底部仍可全部展开或全部收起。</p>
      </div>
      <div class="guide-block">
        <h3>交互与视角</h3>
        <p>拖动人物调整位置，拖动空白处平移，滚轮或双指缩放。关闭“泡泡动态”可暂停漂浮，点击“重置”恢复初始布局。</p>
      </div>
      <div class="guide-block">
        <h3>剧情原文依据</h3>
        <p>悬停或键盘聚焦人物时显示对应连线，开启“全部连线”可同时查看当前画布的关系。点击连线或名录中的“详情”查阅原文与出处；相识类型与明确方向在详情中说明，同阵营不代表存在关系。</p>
      </div>
      <div class="guide-credits">
        <p>人物关系来自已核查的游戏剧情与档案。图片来源、字体许可与第三方内容的权利归属见 <a href="/sources/">来源与版权</a>。</p>
      </div>
    </div>
  `;
}

function search(query) {
  if (!data) return;
  const q = query.trim().toLowerCase();
  searchIndex = -1;
  $('#search').removeAttribute('aria-activedescendant');
  searchMatches = (q
    ? data.nodes.filter(n => [n.name, ...n.aliases].some(x => x.toLowerCase().includes(q)))
    : data.nodes.filter(n => [centerId, 'char_002_amiya', 'char_102_texas', 'char_4228_closur'].includes(n.id))
  ).sort((a, b) => {
    if (a.name.toLowerCase() === q) return -1;
    if (b.name.toLowerCase() === q) return 1;
    return getEdges(b.id).length - getEdges(a.id).length;
  }).slice(0, 12);

  $('#search-results').innerHTML = searchMatches.map((n, i) => `
    <button class="search-result" id="result-${i}" data-search-id="${n.id}" role="option" aria-selected="false">
      <img src="${avatar(n.id)}" alt="">
      <span class="result-info">
        <span>${esc(n.name)}</span>
        <small>${esc(n.factionName)}</small>
      </span>
      <span class="result-deg">${getEdges(n.id).length} 人</span>
    </button>
  `).join('') || '<div style="color: var(--text-muted); padding: 14px; font-size: 13px;">未检索到干员</div>';

  $('#search-results').hidden = false;
  $('#search').setAttribute('aria-expanded', 'true');
}

lifecycle.listen($('#search'), 'input', event => search(event.target.value));
lifecycle.listen($('#search'), 'focus', event => {
  if (data) search(event.target.value);
});
lifecycle.listen($('#search'), 'keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    searchIndex = Math.min(searchMatches.length - 1, Math.max(0, searchIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    $('#search-results').querySelectorAll('[role=option]').forEach((el, i) => el.setAttribute('aria-selected', String(i === searchIndex)));
    $('#search').setAttribute('aria-activedescendant', `result-${searchIndex}`);
    document.getElementById(`result-${searchIndex}`)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && searchMatches.length) {
    event.preventDefault();
    navigate(searchMatches[Math.max(0, searchIndex)].id);
    $('#search').blur();
  } else if (event.key === 'Escape' && !document.querySelector('#community-dialog[open], #account-dialog[open], #feedback-dialog[open]')) {
    $('#search-results').hidden = true;
    $('#search').setAttribute('aria-expanded', 'false');
  }
});

lifecycle.listen($('#search-results'), 'click', event => {
  const button = event.target.closest('[data-search-id]');
  if (button) navigate(button.dataset.searchId);
});

lifecycle.listen($('#panel-content'), 'click', event => {
  const node = event.target.closest('[data-navigate]'),
    locateButton = event.target.closest('[data-locate]'),
    detail = event.target.closest('[data-detail]'),
    retry = event.target.closest('[data-retry]');
  if (node) navigate(node.dataset.navigate);
  else if (locateButton) {
    const id = locateButton.dataset.locate;
    closePanel();
    locate(id);
  } else if (detail) showEdge(detail.dataset.detail);
  else if (retry) showEdge(retry.dataset.retry);
});

lifecycle.handler($('#home'), 'onclick', () => navigate(null));
lifecycle.handler($('#back'), 'onclick', () => {
  if (historyDepth > 0) history.back();
  else if (focus) navigate(null);
});
lifecycle.handler($('#help'), 'onclick', showHelp);
lifecycle.handler($('#close-panel'), 'onclick', () => closePanel());
lifecycle.handler($('#open-list'), 'onclick', showList);
lifecycle.handler($('#group-back'), 'onclick', () => closeGroup());
lifecycle.handler($('#group-prev'), 'onclick', () => changeGroupPage(-1));
lifecycle.handler($('#group-next'), 'onclick', () => changeGroupPage(1));
lifecycle.handler($('#group-members'), 'onclick', () => showList({ groupOnly: true }));
lifecycle.listen($('#factions'), 'click', event => {
  const button = event.target.closest('[data-faction]');
  if (button) selectFaction(button.dataset.faction);
});

lifecycle.handler($('#neighbors'), 'onchange', event => {
  neighbors = event.target.checked;
  render();
  if (neighbors) toast('已开启周围同伴连线');
  history.replaceState(snapshot(), '', location.href);
});

lifecycle.handler($('#expand-all'), 'onclick', () => {
  if (groupView) closeGroup({ restoreFocus: false });
  expanded = new Set(['*']);
  render({ fitView: true });
  history.replaceState(snapshot(), '', location.href);
});
lifecycle.handler($('#collapse-all'), 'onclick', () => {
  if (groupView) closeGroup({ restoreFocus: false });
  expanded.clear();
  render({ fitView: true });
  history.replaceState(snapshot(), '', location.href);
});
lifecycle.handler($('#fit'), 'onclick', () => fit());
lifecycle.handler($('#zoom-in'), 'onclick', () => zoom(1.25));
lifecycle.handler($('#zoom-out'), 'onclick', () => zoom(0.8));
lifecycle.handler($('#reset'), 'onclick', () => {
  positions.clear();
  dragged.clear();
  render({ fitView: true });
  toast('已恢复初始布局');
  history.replaceState(snapshot(), '', location.href);
});

lifecycle.listen(window, 'keydown', event => {
  if (!document.querySelector('#community-dialog[open], #account-dialog[open], #feedback-dialog[open]') && event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    if ($('#panel').open) $('#member-search')?.focus();
    else if (location.hash === '#graph') $('#search').focus();
  }
  if (event.key === 'Escape') {
    if ($('#graph-settings').open) { $('#graph-settings').open = false; $('#graph-settings summary').focus(); }
    if ($('#panel').open) closePanel();
    hidePreview();
    $('#search-results').hidden = true;
    $('#search').setAttribute('aria-expanded', 'false');
  }
});

lifecycle.listen(window, 'click', event => {
  if (!event.target.closest('#graph-settings')) $('#graph-settings').open = false;
  if (!event.target.closest('.search-wrap')) {
    $('#search-results').hidden = true;
    $('#search').setAttribute('aria-expanded', 'false');
  }
});

let resizeTimer;
lifecycle.observe(ResizeObserver, $('#graph-stage'), ([entry]) => {
  lifecycle.clearTimeout(resizeTimer);
  const { width, height } = entry.contentRect;
  // Vue 的人物动作会在图谱恢复后补入页头；最终尺寸与历史一致时保留原缩放。
  if (restoredViewport && Math.abs(width - restoredViewport.width) < 1 && Math.abs(height - restoredViewport.height) < 1) {
    renderedViewport = { width, height };
    restoredViewport = null;
    return;
  }
  // 初次填入头像条也会触发尺寸事件；若当前渲染已适应该尺寸，不能覆盖恢复的相机。
  if (!renderSequence || !width || !height || (Math.abs(width - renderedViewport.width) < 1 && Math.abs(height - renderedViewport.height) < 1)) return;
  resizeTimer = lifecycle.timeout(() => {
    if (data && location.hash === '#graph') {
      restoredViewport = null;
      if (groupView) render({ fitView: true });
      else fit();
    }
  }, 100);
});

const controls = ['search', 'back', 'neighbors', 'expand-all', 'collapse-all', 'open-list', 'zoom-out', 'zoom-in', 'fit', 'reset'];
let publicApi;
let dataRevision = 0;
/** @param {import('../types').AtlasData} next */
function update(next) {
  if (lifecycle.disposed) return;
  const validated = validateAtlasData(next);
  if (data) layoutVersion++;
  dataRevision++;
  data = validated;
  viewCache.clear();
  groupView = groupOverview = null;
  expanded.clear(); positions.clear(); dragged.clear();
    if (!data.nodes.some(n => n.id === new URLSearchParams(location.search).get('person'))) {
      const url = new URL(location.href); url.searchParams.delete('person'); history.replaceState(history.state, '', url);
    }
    document.dispatchEvent(new CustomEvent('atlas:data', { detail: { npcCount: data.npcCount, scope: data.scope } }));
    byId = new Map(data.nodes.map(n => [n.id, n]));
    byEdge = new Map(data.edges.map(e => [e.id, e]));
    factionById = new Map(data.factions.map(f => [f.id, f]));
    adj = new Map(data.nodes.map(n => [n.id, []]));
    for (const e of data.edges) {
      adj.get(e.source).push(e);
      adj.get(e.target).push(e);
    }
    $('#loading').hidden = true;
    controls.forEach(id => $('#' + id).disabled = false);
    $('#workspace').setAttribute('aria-busy', 'false');
    $('#archive-status').textContent = `${data.nodes.length} 位人物收录`;
    $('#faction-total').textContent = String(data.factions.length).padStart(2, '0');
    const starters = [centerId, 'char_002_amiya', 'char_010_chen', 'char_102_texas', 'char_103_angel', 'char_128_plosis'];
    $('#operator-shortcuts').innerHTML = starters.filter(id => byId.has(id)).map(id => `<button class="operator-shortcut" data-shortcut="${id}" aria-pressed="false" aria-label="查看${esc(byId.get(id).name)}的关系"><img src="${avatar(id)}" alt=""><span class="shortcut-copy"><strong>${esc(byId.get(id).name)}</strong><small>${getEdges(id).length} 人关联</small></span></button>`).join('');
    updateShortcutArrows();

    publicApi = {
      getState: () => ({
        focus,
        scopeFaction,
        expanded: [...expanded],
        neighbors,
        nodeCount: data.nodes.length,
        edgeCount: data.edges.length,
        directCount: focus ? getEdges(focus).length : null,
        visiblePeople: visibleNodes.filter(n => n.type === 'person').map(n => n.id),
        groups: groups.map(g => ({ id: g.id, members: g.members.map(n => n.id), expanded: isExpanded(g) })),
        groupView: groupView && { ...groupView },
        groupDetail: groupView && groupDetail(),
        visibleNodes: visibleNodes.map(n => ({ id: n.id, type: n.type, group: n.group, r: n.r, ...currentPoint(n.id) })),
        regions: regions.map(r => ({ ...r })),
        camera: { ...camera },
        positions: Object.fromEntries(positions),
        motion: graphMotion.getState(),
        showAllLines,
        renderSequence
      }),
      navigate,
      closePanel: () => { if (!lifecycle.disposed) closePanel(true); },
      expandGroup: (id, open) => { if (!lifecycle.disposed) toggleGroup(id, open); },
      showEdge,
      locate: id => { if (!lifecycle.disposed) locate(id); },
      getRelation: id => byEdge.get(id)
    };
    window.relationshipAtlas = publicApi;
    if (renderSequence && location.hash === '#graph') {
      focus = byId.has(focus) ? focus : null;
      scopeFaction = factionById.has(scopeFaction) ? scopeFaction : null;
      activeFaction = null;
      navigate(focus, { replace: true, save: false });
    }
    resolveReady(data);
    return data;
}
let loading = false;
async function start() {
  if (lifecycle.disposed || loading) return;
  loading = true;
  const revision = dataRevision;
  controls.forEach(id => $('#' + id).disabled = true);
  try {
    $('#loading').hidden = false;
    const next = await lifecycle.json('/api/graph/?scope=' + (new URLSearchParams(location.search).get('scope') === 'all' ? 'all' : 'operators'));
    if (revision === dataRevision) update(next);
  } catch (error) {
    if (lifecycle.disposed || revision !== dataRevision) return;
    console.warn(error.message);
    $('#archive-status').textContent = '资料暂不可用';
    $('#loading').hidden = false;
    $('#loading').innerHTML = '档案载入失败<br><button class="member-btn member-btn-accent" style="margin-top: 10px;" id="retry-data">重新加载</button>';
    lifecycle.handler($('#retry-data'), 'onclick', start);
  } finally { loading = false; }
}
function dispose() {
  if (lifecycle.disposed) return;
  panelMode = null;
  lifecycle.dispose();
  graphMotion.dispose();
  $('#panel').close();
  for (const id of pointers.keys()) if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
  pointers.clear();
  viewCache.clear();
  if (window.relationshipAtlas === publicApi) delete window.relationshipAtlas;
  resolveReady(null);
}
start();
return { ready: graphReady, update, dispose, enterGraph, leaveGraph, restoreGraph };
}
