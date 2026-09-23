import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from './playwright.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5174';
const graph = JSON.parse(await readFile(new URL('../data/npc/graph.json', import.meta.url), 'utf8'));
const output = new URL('../.runtime/verification/lifecycle/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const results = [], errors = [];
async function mock(context) {
  await context.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
  await context.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/graph/') return route.fulfill({ json: graph });
    if (path === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, registrationEnabled: false } });
    if (path.startsWith('/api/relationships/')) return route.fulfill({ json: { quote: '隔离验收原文', note: '隔离验收关系', sources: [], evidence: [], people: [] } });
    return route.fulfill({ status: 403, json: { detail: 'Isolated browser test' } });
  });
}
async function check(name, fn) { await fn(); results.push(name); console.log(`PASS ${name}`); }
async function settle(page) { await page.waitForTimeout(180); }
async function mountShell(page) {
  await page.evaluate(async () => {
    // 与被测组件复用 Vite 的带版本 URL，避免加载两份 Vue 导致插槽运行时不一致。
    const source = await (await fetch('/src/components/AtlasShell.vue')).text();
    const vueURL = source.match(/from\s+["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vueURL) throw new Error('Cannot resolve the component Vue runtime');
    const { createApp } = await import(vueURL);
    const { default: AtlasShell } = await import('/src/components/AtlasShell.vue');
    createApp(AtlasShell).mount('#app');
  });
}
const state = page => page.evaluate(() => window.relationshipAtlas.getState());
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await mock(context);
  await context.addInitScript(() => {
    const listeners = [], observers = new Set(), frames = new Set(), timers = new Map();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const tracked = target => target === window || target === document || target instanceof MediaQueryList;
    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
    EventTarget.prototype.addEventListener = function(type, fn, options) {
      if (tracked(this) && !listeners.some(item => item.target === this && item.type === type && item.fn === fn && item.capture === capture(options))) listeners.push({ target: this, type, fn, capture: capture(options) });
      return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function(type, fn, options) {
      const index = listeners.findIndex(item => item.target === this && item.type === type && item.fn === fn && item.capture === capture(options));
      if (index >= 0) listeners.splice(index, 1);
      return remove.call(this, type, fn, options);
    };
    for (const key of ['ResizeObserver', 'IntersectionObserver']) {
      const Native = window[key];
      window[key] = class extends Native {
        observe(...args) { observers.add(this); return super.observe(...args); }
        disconnect() { observers.delete(this); return super.disconnect(); }
      };
    }
    const raf = requestAnimationFrame, caf = cancelAnimationFrame, timeout = setTimeout, clear = clearTimeout;
    window.requestAnimationFrame = fn => { const id = raf(time => { frames.delete(id); fn(time); }); frames.add(id); return id; };
    window.cancelAnimationFrame = id => { frames.delete(id); caf(id); };
    window.setTimeout = (fn, delay, ...args) => { const id = timeout(() => { timers.delete(id); fn(...args); }, delay); timers.set(id, new Error().stack); return id; };
    window.clearTimeout = id => { timers.delete(id); clear(id); };
    window.__resources = () => ({ globals: listeners.length, observers: observers.size, frames: frames.size, timers: [...timers.values()].filter(stack => stack.includes('/src/atlas/')).length });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?person=char_003_kalts#graph`);
  await page.waitForFunction(() => window.relationshipAtlas && window.terraPortal?.getState().renderer);
  await check('search, grouped pages, filters and back history', async () => {
    await page.locator('#search').fill('陈');
    await page.locator('#search-results [data-search-id]').first().waitFor();
    await page.locator('#search').press('ArrowDown'); await page.locator('#search').press('Enter');
    assert.notEqual((await state(page)).focus, 'char_003_kalts');
    await page.goBack(); await page.waitForFunction(() => window.relationshipAtlas.getState().focus === 'char_003_kalts');
    const before = await state(page);
    const group = before.groups.find(group => group.members.length > 12);
    assert.ok(group);
    await page.locator(`[data-node="g:${group.id}"]`).press('Enter');
    assert.equal((await state(page)).groupView.id, group.id);
    if (!await page.locator('#group-next').isDisabled()) {
      const previous = (await state(page)).groupView.page;
      await page.locator('#group-next').click();
      assert.equal((await state(page)).groupView.page, previous + 1);
      await page.locator('#group-prev').click();
    }
    await page.locator('#group-back').click();
    assert.equal((await state(page)).groupView, null);
    await page.locator('#factions [data-faction]').first().click();
    assert.ok(await page.locator('#factions [aria-pressed="true"]').count());
    await page.locator('#open-list').click();
    await page.locator('#member-search').fill('阿米娅');
    assert.match(await page.locator('#member-list').innerText(), /阿米娅/);
    await page.keyboard.press('Escape');
  });
  await check('leaving and returning keeps one set of graph resources', async () => {
    await settle(page);
    const before = await page.evaluate(() => window.__resources());
    for (let i = 0; i < 3; i++) {
      await page.locator('.site-nav a[data-page="home"]').click();
      await page.waitForFunction(() => window.terraPortal.getState().page === 'home');
      await page.goBack();
      await page.waitForFunction(() => window.terraPortal.getState().page === 'graph');
    }
    await settle(page);
    const after = await page.evaluate(() => window.__resources());
    assert.equal(after.globals, before.globals); assert.equal(after.observers, before.observers);
    assert.ok(after.frames <= 1);
  });
  await check('Vue unmount/remount clears actual listeners, observers and scheduled callbacks', async () => {
    await page.evaluate(() => document.getElementById('app').__vue_app__.unmount());
    await settle(page);
    const baseline = await page.evaluate(() => window.__resources());
    assert.equal(baseline.observers, 0); assert.equal(baseline.frames, 0);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      await mountShell(page);
      await page.waitForFunction(() => window.relationshipAtlas && window.terraPortal?.getState().renderer);
      await page.locator('#search').fill('阿米娅');
      await page.locator('#search').press('Enter');
      await page.evaluate(() => document.getElementById('app').__vue_app__.unmount());
      await settle(page);
      const current = await page.evaluate(() => window.__resources());
      assert.deepEqual(current, baseline);
      assert.equal(await page.evaluate(() => !!window.relationshipAtlas || !!window.terraPortal), false);
      samples.push(current);
    }
    await writeFile(new URL('resources.json', output), JSON.stringify({ baseline, samples }, null, 2));
  });
  await check('same-root initialization replaces old owner, update validates and disposal ignores late fetches', async () => {
    await mountShell(page);
    await page.evaluate(data => { window.__data = data; }, graph);
    await page.waitForFunction(() => window.relationshipAtlas && window.terraPortal?.getState().renderer);
    const answer = await page.evaluate(async () => {
      const { createAtlas } = await import('/src/atlas/portal.js');
      const root = document.getElementById('app');
      const first = createAtlas(root); await first.ready;
      const second = createAtlas(root); await second.ready;
      first.dispose();
      const validAfterOldDispose = !!window.relationshipAtlas;
      const original = window.relationshipAtlas.getState().nodeCount;
      let rejected = false;
      try { second.update({ ...window.__data, edges: [{ id: 'bad', source: 'missing', target: 'missing', kind: 'mutual' }] }); } catch { rejected = true; }
      const unchanged = window.relationshipAtlas.getState().nodeCount === original;
      second.update({ ...window.__data, edges: window.__data.edges.slice(0, -1) });
      const updated = window.relationshipAtlas.getState().edgeCount === window.__data.edges.length - 1;
      const stale = window.relationshipAtlas;
      second.dispose(); second.dispose();
      stale.navigate('char_002_amiya'); stale.expandGroup('rhodes', true); stale.closePanel();
      const race = createAtlas(root);
      race.update({ ...window.__data, edges: window.__data.edges.slice(0, -1) });
      race.update({ ...window.__data, edges: window.__data.edges.slice(0, -2), factions: window.__data.factions.map((faction, index) => index ? faction : { ...faction, name: 'Updated faction' }) });
      await race.ready;
      await new Promise(resolve => setTimeout(resolve, 120));
      const latestWins = window.relationshipAtlas.getState().edgeCount === window.__data.edges.length - 2 && root.querySelector('#faction-directory').textContent.includes('Updated faction');
      race.dispose();
      const delayed = createAtlas(root);
      delayed.dispose();
      await delayed.ready;
      await new Promise(resolve => setTimeout(resolve, 120));
      return { validAfterOldDispose, rejected, unchanged, updated, latestWins, apiCleared: !window.relationshipAtlas && !window.terraPortal, resources: window.__resources() };
    });
    assert.equal(answer.validAfterOldDispose, true); assert.equal(answer.rejected, true); assert.equal(answer.unchanged, true); assert.equal(answer.apiCleared, true); assert.equal(answer.updated, true); assert.equal(answer.latestWins, true);
    assert.equal(answer.resources.observers, 0); assert.equal(answer.resources.frames, 0);
  });
  await context.close();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await mock(mobile);
  const touch = await mobile.newPage(); touch.setDefaultTimeout(10000); touch.on('pageerror', e => errors.push(e.message));
  await check('touch graph navigation, pan, history and game entry', async () => {
    await touch.goto(`${base}/?person=char_003_kalts#graph`);
    await touch.waitForFunction(() => window.relationshipAtlas);
    await touch.locator('#site-menu-open').tap();
    await touch.locator('#site-menu a[href="/game/"]').tap();
    await touch.getByRole('heading', { name: '人物连线', exact: true }).waitFor();
    assert.equal(await touch.getByRole('button', { name: '反馈问题', exact: true }).count(), 1);
    await touch.goBack();
    await touch.waitForFunction(() => window.relationshipAtlas);
    const group = (await state(touch)).groups[0];
    await touch.locator(`[data-node="g:${group.id}"]`).tap();
    assert.equal((await state(touch)).groupView.id, group.id);
    await touch.locator('#group-back').tap();
    const before = (await state(touch)).camera;
    const box = await touch.locator('#graph').boundingBox();
    const cdp = await mobile.newCDPSession(touch);
    const x = box.x + box.width * .8, y = box.y + box.height * .8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 45, y: y - 35 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notDeepEqual((await state(touch)).camera, before);
    await cdp.detach();

  });
  await mobile.close();
  assert.deepEqual(errors, []);
  await writeFile(new URL('results.json', output), JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
