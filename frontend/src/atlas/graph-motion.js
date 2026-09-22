import { createLifecycle } from './lifecycle.js';

// 浮动与过渡只更新显示坐标，不写入布局／历史。边和头像由同一帧绘制。
export function curveBetween(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const bend = Math.min(32, Math.hypot(dx, dy) * .08);
  const length = Math.hypot(dx, dy) || 1;
  const c = { x: (a.x + b.x) / 2 - dy / length * bend, y: (a.y + b.y) / 2 + dx / length * bend };
  return { d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`, c };
}

const seedFor = id => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) / 0xffffffff;

export class GraphMotion {
  constructor({ svg, nodes, edges, sparks, position, camera }) {
    this.lifecycle = createLifecycle();
    Object.assign(this, { svg, nodes, edges, sparks, position, camera });
    this.items = new Map();
    this.links = [];
    this.active = false;
    this.enabled = true;
    this.frame = 0;
    this.frameCount = 0;
    this.visible = true;
    this.tick = this.tick.bind(this);
    this.lifecycle.listen(document, 'visibilitychange', () => this.sync());
    this.lifecycle.observe(IntersectionObserver, svg, ([entry]) => { this.visible = entry.isIntersecting; this.sync(); });
  }

  capture() {
    const points = new Map();
    for (const el of this.nodes.children) {
      const label = el.getCTM();
      const bubble = (el.querySelector('.node-bubble') || el).getCTM();
      if (label && bubble) points.set(el.dataset.node, { x: bubble.e, y: bubble.f, labelX: label.e, labelY: label.f });
    }
    return points;
  }

  mount(nodes, edges, previous, kind = 'layout') {
    const now = performance.now(), camera = this.camera();
    const oldItems = this.items;
    this.items = new Map();
    const elements = new Map([...this.nodes.children].map(el => [el.dataset.node, el]));
    const anchor = previous.get(nodes.find(n => n.center)?.id);
    for (const [index, node] of nodes.entries()) {
      const base = this.position(node.id);
      let from = previous.get(node.id);
      if (!from && node.type === 'group') {
        const members = node.group.members.map(n => previous.get(n.id)).filter(Boolean);
        if (members.length) from = { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length };
      }
      if (!from && kind !== 'page') from = previous.get(`g:${node.group}`) || anchor;
      if (!from && kind === 'page' && previous.size) from = { x: camera.x + (base.x - 20) * camera.k, y: camera.y + base.y * camera.k };
      const old = oldItems.get(node.id);
      const moving = this.enabled && previous.size && from;
      this.items.set(node.id, {
        el: elements.get(node.id), bubble: elements.get(node.id)?.querySelector('.node-bubble'), node, seed: seedFor(node.id) * Math.PI * 2,
        x: base.x, y: base.y, ox: old?.ox || 0, oy: old?.oy || 0,
        from: moving ? {
          x: (from.x - camera.x) / camera.k, y: (from.y - camera.y) / camera.k,
          labelX: ((from.labelX ?? from.x) - camera.x) / camera.k, labelY: ((from.labelY ?? from.y) - camera.y) / camera.k
        } : null,
        start: now + (moving ? Math.min(index * 9, 90) : 0),
        duration: kind === 'page' ? 300 : 560,
        release: null, held: null
      });
    }
    const edgeElements = new Map([...this.edges.children].map(el => [el.dataset.edgeGroup, el]));
    this.links = edges.map(edge => ({ edge, el: edgeElements.get(edge.id), paths: [...(edgeElements.get(edge.id)?.querySelectorAll('path') || [])] }));
    this.hovered = null;
    this.dragged = null;
    this.sparks.replaceChildren();
    if (kind === 'group' && this.enabled && previous.size) {
      const group = nodes.find(n => n.group)?.group;
      const origin = previous.get(`g:${group}`);
      if (origin) {
        const p = { x: (origin.x - camera.x) / camera.k, y: (origin.y - camera.y) / camera.k };
        this.burst = { ...p, start: now };
        this.sparks.innerHTML = Array.from({ length: 10 }, (_, i) => `<circle r="${(i % 3 + 2) / camera.k / 2}"/>`).join('');
      }
    }
    this.paint(now, true);
    this.sync();
  }

  setActive(active) { this.active = active; this.sync(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      for (const item of this.items.values()) Object.assign(item, { from: null, ox: 0, oy: 0, release: null, held: null });
      this.sparks.replaceChildren();
      this.paint(performance.now(), true);
    }
    this.sync();
  }

  setEdges(all, id = this.hovered) {
    this.allEdges = all;
    this.edgeFocus = id;
    this.paintEdges();
  }

  hover(id) {
    if (id === this.hovered && (this.items.get(id)?.held || this.items.get(id)?.from)) return;
    const old = this.items.get(this.hovered);
    if (old?.held) {
      const base = this.position(this.hovered);
      old.ox = old.held.x - base.x; old.oy = old.held.y - base.y;
      old.held = null;
    }
    this.hovered = id;
    const item = this.items.get(id);
    if (item && !item.from) {
      // 鼠标／键盘瞄准时固定当前位置，避免头像从指针下漂走。
      // 经过指针的入场节点仍须完成过渡，不能被冻结在另一人的位置上。
      item.held = { x: item.x, y: item.y };
    }
  }

  point(id) {
    const item = this.items.get(id);
    return item ? { x: item.x, y: item.y } : this.position(id);
  }

  beginDrag(id) {
    this.dragged = id;
    const item = this.items.get(id);
    if (item) { item.from = null; item.held = null; item.release = null; }
  }

  move(id) {
    const item = this.items.get(id);
    if (item) { item.ox = item.oy = 0; item.from = null; }
    this.paint(performance.now(), true);
  }

  release(id, velocity = { x: 0, y: 0 }) {
    this.dragged = null;
    const item = this.items.get(id);
    if (!item) return;
    item.held = null;
    if (this.enabled) item.release = { start: performance.now(), x: Math.max(-10, Math.min(10, velocity.x * 12)) / this.camera().k, y: Math.max(-10, Math.min(10, velocity.y * 12)) / this.camera().k };
    this.sync();
  }

  dispose() {
    this.active = false;
    this.lifecycle.dispose();
    this.frame = 0;
    this.items.clear(); this.links = [];
  }

  sync() {
    if (this.lifecycle.disposed) return;
    const run = this.active && this.enabled && this.visible && !document.hidden && this.items.size;
    if (!run) { this.lifecycle.cancelFrame(this.frame); this.frame = 0; this.lastTime = 0; }
    else if (!this.frame) { this.lastTime = 0; this.frame = this.lifecycle.frame(this.tick); }
  }

  tick(now) {
    if (this.lifecycle.disposed) return;
    this.frame = this.lifecycle.frame(this.tick);
    // 大总览限制绘制频率，隐去的线不参与逐帧更新。
    if (this.lastTime && now - this.lastTime < (this.items.size > 120 ? 32 : 15)) return;
    this.paint(now);
    this.lastTime = now;
    this.frameCount++;
  }

  paint(now, immediate = false) {
    const k = this.camera().k;
    const dt = this.lastTime ? Math.min(50, now - this.lastTime) : 16;
    const ease = immediate ? 1 : 1 - Math.exp(-dt / 180);
    const dense = this.items.size > 120;
    for (const [id, item] of this.items) {
      const base = this.position(id);
      const amplitude = (item.node.center ? .8 : item.node.type === 'group' ? 3.5 : dense ? 1.4 : 2.6) / k;
      const driftX = this.enabled ? Math.sin(now / 2700 + item.seed) * amplitude : 0;
      const driftY = this.enabled ? Math.cos(now / 3100 + item.seed * 1.3) * amplitude : 0;
      item.ox += (driftX - item.ox) * ease;
      item.oy += (driftY - item.oy) * ease;
      let x = base.x + item.ox, y = base.y + item.oy;
      // 文字跟随布局和拖动，不参与漂浮与回弹，避免持续起伏影响阅读。
      let labelX = base.x, labelY = base.y;
      if (item.from) {
        const t = Math.max(0, Math.min(1, (now - item.start) / item.duration));
        const progress = 1 - Math.pow(1 - t, 4);
        x = item.from.x + (x - item.from.x) * progress;
        y = item.from.y + (y - item.from.y) * progress;
        labelX = item.from.labelX + (base.x - item.from.labelX) * progress;
        labelY = item.from.labelY + (base.y - item.from.labelY) * progress;
        if (t === 1) item.from = null;
      }
      if (item.release) {
        const t = (now - item.release.start) / 1000;
        const spring = Math.sin(t * 16) * Math.exp(-t * 8);
        x += item.release.x * spring;
        y += item.release.y * spring;
        if (t > .65) item.release = null;
      }
      if (item.held) ({ x, y } = item.held);
      if (id === this.dragged) { x = base.x; y = base.y; }
      item.x = x; item.y = y;
      const labelTransform = `translate(${labelX.toFixed(3)} ${labelY.toFixed(3)})`;
      if (item.labelTransform !== labelTransform) {
        item.el?.setAttribute('transform', labelTransform);
        item.labelTransform = labelTransform;
      }
      item.bubble?.setAttribute('transform', `translate(${(x - labelX).toFixed(3)} ${(y - labelY).toFixed(3)})`);
    }
    this.paintEdges();
    if (this.burst && this.sparks.children.length) {
      const t = Math.min(1, (now - this.burst.start) / 650);
      [...this.sparks.children].forEach((el, i) => {
        const angle = i * 2.39996, distance = (12 + i * 2.5) * (1 - Math.pow(1 - t, 3)) / k;
        el.setAttribute('cx', this.burst.x + Math.cos(angle) * distance);
        el.setAttribute('cy', this.burst.y + Math.sin(angle) * distance);
        el.setAttribute('opacity', String(.5 * (1 - t)));
      });
      if (t === 1) { this.sparks.replaceChildren(); this.burst = null; }
    }
  }

  paintEdges() {
    for (const { edge, paths } of this.links) {
      if (!edge.aggregate && !this.allEdges && edge.source !== this.edgeFocus && edge.target !== this.edgeFocus) continue;
      const a = this.point(edge.source), b = this.point(edge.target);
      const { d } = curveBetween(a, b);
      for (const path of paths) path.setAttribute('d', d);
    }
  }

  getState() {
    return { running: !!this.frame, enabled: this.enabled, frameCount: this.frameCount, moving: [...this.items.values()].filter(item => item.from || item.release).length };
  }
}
