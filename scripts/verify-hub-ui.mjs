import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { chromium } from './playwright.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:2747';
const output = await verificationDirectory('hubs');
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const checks = [], errors = [], failures = [], geometry = [];
const kaltsit = 'char_003_kalts';
const state = p => p.evaluate(() => window.relationshipAtlas.getState());
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, error: e.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function page(viewport, touch = false) {
  const p = await browser.newPage({ viewport, reducedMotion: 'reduce', isMobile: touch, hasTouch: touch });
  p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('response', r => { if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() }); });
  return p;
}
async function ready(p, id = kaltsit, scope = 'all') {
  await p.goto('about:blank');
  await p.goto(`${base}/?scope=${scope}&faction=kazimierz&person=${id}#graph`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.relationshipAtlas && window.terraPortal);
  await p.evaluate(() => document.fonts.ready);
}
async function capture(p, name) {
  await p.waitForLoadState('networkidle');
  await p.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('#nodes image')].map(el => {
      const img = new Image(); img.src = el.getAttribute('href'); return img.decode();
    }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await p.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
function packed(s) {
  const regions = s.regions;
  const center = s.visibleNodes.find(n => n.id === s.focus);
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], members = s.visibleNodes.filter(n => n.group === r.id);
    assert.equal(members.length, r.count, `Empty or incomplete region: ${r.id}`);
    assert.ok(Math.hypot(r.x - center.x, r.y - center.y) > r.r + center.r, 'Region overlaps the focus');
    for (const n of members) assert.ok(Math.hypot(n.x - r.x, n.y - r.y) + n.r <= r.r, `${n.id} outside ${r.id}`);
    for (const b of regions.slice(i + 1)) assert.ok(Math.hypot(r.x - b.x, r.y - b.y) > r.r + b.r, `${r.id} overlaps ${b.id}`);
  }
  geometry.push({ focus: s.focus, people: s.visiblePeople.length, regions: regions.length, contained: true });
}
async function readable(p) {
  const result = await p.evaluate(() => {
    const stage = document.querySelector('#graph').getBoundingClientRect();
    const controls = document.querySelector('#group-browser').getBoundingClientRect();
    const rect = r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      stage: rect(stage), controls: rect(controls),
      nodes: [...document.querySelectorAll('#nodes .person-node')].map(el => ({
        id: el.dataset.node,
        circle: rect(el.querySelector('.bubble-sphere-base').getBoundingClientRect()),
        label: rect(el.querySelector('.name').getBoundingClientRect())
      }))
    };
  });
  assert.equal(result.overflow, false);
  assert.ok(result.controls.right <= result.stage.right);
  for (const n of result.nodes) {
    assert.ok(n.circle.width >= 44, `Small hit target ${n.id}: ${n.circle.width}`);
    assert.ok(n.circle.y >= result.controls.bottom, `Node behind controls: ${n.id}`);
    assert.ok(n.label.height >= 12, `Unreadable label: ${n.id}`);
    assert.ok(n.label.bottom <= result.stage.bottom + 1 && n.label.x >= result.stage.x - 1 && n.label.right <= result.stage.right + 1, `Clipped label: ${n.id}`);
  }
  for (const [i, a] of result.nodes.entries()) for (const b of result.nodes.slice(i + 1)) {
    for (const ra of [a.circle, a.label]) for (const rb of [b.circle, b.label]) assert.ok(ra.right <= rb.x || rb.right <= ra.x || ra.bottom <= rb.y || rb.bottom <= ra.y, `Overlapping people: ${a.id}, ${b.id}`);
  }
}
const desktop = await page({ width: 1440, height: 960 });
const graph = await (await desktop.request.get(base + '/api/graph/?scope=all')).json();
const byId = new Map(graph.nodes.map(n => [n.id, n]));
await check('dense person opens as a complete group overview', async () => {
  await ready(desktop);
  const s = await state(desktop);
  assert.equal(s.directCount, 235);
  assert.equal(s.visiblePeople.length, 1);
  const members = s.groups.flatMap(g => g.members);
  assert.equal(new Set(members).size, 235);
  assert.equal(members.length, 235);
});
await check('group click isolates the group and keeps readable portraits and names', async () => {
  await desktop.locator('[data-node="g:rhodes"]').focus();
  await desktop.keyboard.press('Enter');
  const s = await state(desktop);
  assert.equal(s.groupView.id, 'rhodes');
  assert.equal(s.visiblePeople.length, s.groupDetail.size + 1);
  assert.ok(s.visiblePeople.filter(id => id !== kaltsit).every(id => byId.get(id).factionId === 'rhodes'));
  await readable(desktop);
  await capture(desktop, 'desktop');
});
await check('pagination covers every member exactly once and stops at the last page', async () => {
  for (const id of ['rhodes', 'other']) {
    if (id === 'other') { await desktop.locator('#group-back').click(); await desktop.locator('[data-node="g:other"]').click(); }
    const expected = (await state(desktop)).groupDetail.members.map(n => n.id), seen = [];
    while (true) {
      const s = await state(desktop);
      seen.push(...s.visiblePeople.filter(id => id !== kaltsit));
      if (await desktop.locator('#group-next').isDisabled()) break;
      await desktop.locator('#group-next').click();
    }
    assert.deepEqual(new Set(seen), new Set(expected));
    assert.equal(seen.length, expected.length);
    await readable(desktop);
  }
});
await check('sidebar faction selection shows only that faction within a combined group', async () => {
  await desktop.locator('[data-faction="yan"]').click();
  const s = await state(desktop);
  assert.equal(s.groupView.faction, 'yan');
  assert.ok(s.visiblePeople.filter(id => id !== kaltsit).every(id => byId.get(id).factionId === 'yan'));
  assert.equal(s.groupDetail.members.length, 17);
});
await check('group list can locate a member on a later page without changing the focus', async () => {
  await desktop.locator('[data-faction="rhodes"]').click();
  const last = (await state(desktop)).groupDetail.members.at(-1);
  await desktop.locator('#group-members').click();
  assert.equal(await desktop.locator('.member-row').count(), 65);
  await desktop.locator('#member-search').fill(last.name);
  await desktop.locator(`[data-locate="${last.id}"]`).click();
  const s = await state(desktop);
  assert.equal(s.focus, kaltsit);
  assert.ok(s.groupView.page > 0 && s.visiblePeople.includes(last.id));
});
await check('history and refresh restore the selected group, page, camera and dragged node', async () => {
  await desktop.locator('#group-prev').click();
  const id = (await state(desktop)).visiblePeople.find(id => id !== kaltsit);
  const circle = desktop.locator(`[data-node="${id}"] .bubble-sphere-base`), box = await circle.boundingBox();
  await desktop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await desktop.mouse.down(); await desktop.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8, { steps: 5 }); await desktop.mouse.up();
  await desktop.locator('#zoom-in').click();
  const before = await state(desktop);
  await desktop.locator('[data-shortcut="char_002_amiya"]').click();
  await desktop.goBack();
  const restored = await state(desktop);
  assert.deepEqual(restored.groupView, before.groupView);
  assert.deepEqual(restored.camera, before.camera);
  assert.deepEqual(restored.positions[id], before.positions[id]);
  await desktop.reload({ waitUntil: 'networkidle' });
  const refreshed = await state(desktop);
  assert.deepEqual(refreshed.groupView, before.groupView);
  assert.deepEqual(refreshed.camera, before.camera);
  assert.deepEqual(refreshed.positions[id], before.positions[id]);
});
await check('return restores the overview after dragging its group and browsing pages', async () => {
  await ready(desktop);
  const bubble = desktop.locator('[data-node="g:rhodes"] .group-bubble-body'), box = await bubble.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await desktop.mouse.move(x, y); await desktop.mouse.down(); await desktop.mouse.move(x + 24, y + 12, { steps: 5 }); await desktop.mouse.up();
  const before = await state(desktop);
  await desktop.locator('[data-node="g:rhodes"]').click();
  await desktop.locator('#group-next').click(); await desktop.locator('#group-back').click();
  const after = await state(desktop);
  assert.equal(after.groupView, null);
  assert.deepEqual(after.positions['g:rhodes'], before.positions['g:rhodes']);
  assert.deepEqual(after.camera, before.camera);
});
await check('hover emphasizes the chosen relation and its line opens the correct evidence', async () => {
  await ready(desktop);
  await desktop.locator('[data-node="g:rhodes"]').click();
  const s = await state(desktop), id = s.visiblePeople.find(id => id !== kaltsit), edge = [id, kaltsit].sort().join('|');
  await desktop.locator(`[data-node="${id}"]`).hover();
  assert.equal(await desktop.locator('.edge-highlight').count(), 1);
  const hit = desktop.locator(`[data-edge="${edge}"]`);
  const point = await hit.evaluate(el => {
    const transform = el.getScreenCTM();
    const along = el.getPointAtLength(el.getTotalLength() * .55);
    const p = new DOMPoint(along.x, along.y).matrixTransform(transform);
    return { x: p.x, y: p.y };
  });
  await desktop.mouse.click(point.x, point.y);
  await desktop.locator('.dossier-quote').waitFor();
  assert.ok((await desktop.locator('.dossier-id').innerText()).includes(edge));
  await desktop.keyboard.press('Escape');
});
await check('bulk expansion keeps regions disjoint and every portrait inside its own group', async () => {
  const degrees = new Map(graph.nodes.map(n => [n.id, 0]));
  for (const e of graph.edges) { degrees.set(e.source, degrees.get(e.source) + 1); degrees.set(e.target, degrees.get(e.target) + 1); }
  const ids = [...new Set([kaltsit, ...[...degrees].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)])];
  for (const id of ids) {
    await ready(desktop, id); await desktop.locator('#expand-all').click();
    let s = await state(desktop); assert.equal(s.visiblePeople.length, s.directCount + 1); packed(s);
    if (id === kaltsit) await capture(desktop, 'desktop-all');
    await desktop.locator('#collapse-all').click();
    assert.equal((await state(desktop)).visiblePeople.length, 1);
    for (const group of s.groups.slice().reverse()) { await desktop.evaluate(id => window.relationshipAtlas.expandGroup(id, true), group.id); packed(await state(desktop)); }
  }
});
await check('operator-only scope retains all 197 relationships', async () => {
  await ready(desktop, kaltsit, 'operators');
  assert.equal((await state(desktop)).directCount, 197);
  await desktop.locator('[data-node="g:rhodes"]').click();
  assert.ok((await state(desktop)).groupDetail.members.every(n => n.isOperator));
});
await check('old cached coordinates are replaced instead of restoring the overlapping layout', async () => {
  await ready(desktop);
  await desktop.evaluate(() => {
    const saved = { ...history.state, expanded: ['rhodes', 'rainbow'], coords: { char_003_kalts: { x: 99999, y: 99999 }, 'g:rhodes': { x: 0, y: 0 } } };
    delete saved.layoutVersion;
    history.replaceState(saved, '', location.href);
  });
  await desktop.reload({ waitUntil: 'networkidle' });
  const s = await state(desktop);
  assert.equal(s.positions[kaltsit].x, 0);
  packed(s);
});
for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
  const mobile = await page(viewport, true);
  await check(`${name} has readable touch targets, pagination and return`, async () => {
    await ready(mobile);
    await mobile.locator('[data-node="g:rhodes"]').tap();
    await readable(mobile);
    await capture(mobile, name);
    const first = (await state(mobile)).visiblePeople;
    await mobile.locator('#group-next').tap(); assert.notDeepEqual((await state(mobile)).visiblePeople, first);
    await mobile.locator('#group-prev').tap(); assert.deepEqual((await state(mobile)).visiblePeople, first);
    if (name === 'mobile') {
      await mobile.setViewportSize({ width: 844, height: 390 });
      await mobile.waitForFunction(() => window.relationshipAtlas.getState().groupView.layout.endsWith(':false'));
      await readable(mobile);
    }
    await mobile.locator('#group-back').tap(); assert.equal((await state(mobile)).groupView, null);
  });
  await mobile.close();
}
await browser.close();
const result = { checks, errors, failures, geometry, pass: checks.every(c => c.pass) && !errors.length && !failures.length };
await fs.writeFile(path.join(output, 'ui-checks.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ checks: checks.length, failed: checks.filter(c => !c.pass), errors, failedRequests: failures.length }));
if (!result.pass) process.exitCode = 1;
