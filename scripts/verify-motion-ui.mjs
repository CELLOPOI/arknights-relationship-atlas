import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './playwright.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:2747';
const output = await verificationDirectory('motion');
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [], metrics = {};
const kaltsit = 'char_003_kalts';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function createPage(viewport = { width: 1440, height: 960 }, touch = false) {
  const p = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
  p.setDefaultTimeout(10000);
  p.on('pageerror', error => errors.push(error.message));
  return p;
}
async function ready(p) {
  await p.goto(`${base}/?scope=all&person=${kaltsit}#graph`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.relationshipAtlas);
  await p.evaluate(() => document.fonts.ready);
  await delay(700);
}
const state = p => p.evaluate(() => window.relationshipAtlas.getState());
async function center(p, id) {
  return p.locator(`[data-node="${id}"] circle`).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
}
async function clickNode(p, id, touch = false) {
  const point = await center(p, id);
  if (touch) await p.touchscreen.tap(point.x, point.y);
  else { await p.mouse.move(point.x, point.y); await p.mouse.click(point.x, point.y); }
}
async function setting(p, id, checked) {
  if (!await p.locator('#graph-settings').evaluate(el => el.open)) await p.locator('#graph-settings summary').click();
  if (await p.locator('#' + id).isChecked() !== checked) await p.locator(`label:has(#${id})`).click();
  await p.locator('#graph-settings summary').click();
}
async function capture(p, name) {
  await p.waitForLoadState('networkidle');
  await delay(250);
  await p.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('#nodes image')].map(el => { const img = new Image(); img.src = el.getAttribute('href'); return img.decode(); }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await p.screenshot({ path: path.join(output, name + '.png') });
}
async function stableLabels(p, name) {
  const read = () => p.evaluate(() => [...document.querySelectorAll('#nodes > g')].map(el => {
    const label = el.querySelector('.name, .group-name').getBoundingClientRect();
    const bubble = el.querySelector('circle').getBoundingClientRect();
    return { id: el.dataset.node, label: { x: label.x, y: label.y }, bubble: { x: bubble.x, y: bubble.y } };
  }));
  const first = await read();
  let labelShift = 0, bubbleShift = 0;
  for (let i = 0; i < 4; i++) {
    await delay(250);
    const next = await read();
    for (const [index, item] of next.entries()) {
      assert.equal(item.id, first[index].id);
      labelShift = Math.max(labelShift, Math.hypot(item.label.x - first[index].label.x, item.label.y - first[index].label.y));
      bubbleShift = Math.max(bubbleShift, Math.hypot(item.bubble.x - first[index].bubble.x, item.bubble.y - first[index].bubble.y));
    }
  }
  assert.ok(labelShift < .01, `Names drifted: ${labelShift}px`);
  assert.ok(bubbleShift > .05, 'Portrait drift unexpectedly stopped');
  metrics[name] = { labelShift, bubbleShift };
}
const desktop = await createPage();
await check('idle drift stays bounded and never writes into saved layout', async () => {
  await ready(desktop);
  const before = await state(desktop), a = await center(desktop, 'g:rhodes');
  await delay(700);
  const after = await state(desktop), b = await center(desktop, 'g:rhodes');
  assert.ok(after.motion.running && after.motion.frameCount > before.motion.frameCount);
  assert.deepEqual(after.positions, before.positions);
  const movement = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(movement > .05 && movement < 8, `Unexpected drift: ${movement}`);
  metrics.idleMovement = movement;
  await stableLabels(desktop, 'overviewLabels');
});
await check('opening a group keeps spatial continuity and settles without stale particles', async () => {
  const origin = await center(desktop, 'g:rhodes');
  await clickNode(desktop, 'g:rhodes');
  const s = await state(desktop), id = s.visiblePeople.find(id => id !== kaltsit);
  assert.equal(s.groupView.id, 'rhodes');
  assert.ok(s.motion.moving > 0);
  const first = await center(desktop, id);
  assert.ok(Math.hypot(first.x - origin.x, first.y - origin.y) < 350);
  await delay(800);
  assert.equal((await state(desktop)).motion.moving, 0);
  assert.equal(await desktop.locator('#graph-sparks circle').count(), 0);
  const offsets = await desktop.evaluate(() => {
    const s = window.relationshipAtlas.getState();
    return [...document.querySelectorAll('#nodes > g')].map(el => {
      const matrix = el.querySelector('.node-bubble').getCTM(), target = s.positions[el.dataset.node];
      return { id: el.dataset.node, distance: Math.hypot(matrix.e - s.camera.x - target.x * s.camera.k, matrix.f - s.camera.y - target.y * s.camera.k) };
    });
  });
  assert.ok(offsets.every(p => p.distance < 5), `A node stopped during entry: ${JSON.stringify(offsets.filter(p => p.distance >= 5))}`);
});
await check('names stay still while portraits float and remain clickable', async () => {
  await desktop.mouse.move(10, 100);
  await stableLabels(desktop, 'desktopNames');
  const id = (await state(desktop)).visiblePeople.find(id => id !== kaltsit);
  const namePoint = await desktop.locator(`[data-node="${id}"] .name`).evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  // SVG 文字的定位器会转向包含浮动头像的按钮，使用实际姓名位置执行鼠标点击。
  await desktop.mouse.click(namePoint.x, namePoint.y);
  assert.equal((await state(desktop)).focus, id);
  await desktop.goBack(); await delay(800);
  assert.equal((await state(desktop)).groupView.id, 'rhodes');
});
await check('hover holds the portrait and reveals only its correctly attached relationship', async () => {
  const s = await state(desktop), id = s.visiblePeople.find(id => id !== kaltsit);
  const point = await center(desktop, id);
  await desktop.mouse.move(point.x, point.y);
  const a = await center(desktop, id);
  await delay(350);
  const b = await center(desktop, id);
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < .01);
  assert.equal(await desktop.locator('.edge-highlight').count(), 1);
  const visible = await desktop.locator('.edge-line').evaluateAll(els => els.filter(el => +getComputedStyle(el).strokeOpacity > .1).length);
  assert.equal(visible, 1);
  const edgeId = [id, kaltsit].sort().join('|');
  const hit = desktop.locator(`[data-edge="${edgeId}"]`);
  const geometry = await hit.evaluate(el => {
    const matrix = el.getScreenCTM(), end = el.getPointAtLength(el.getTotalLength()), start = el.getPointAtLength(0), mid = el.getPointAtLength(el.getTotalLength() * .55);
    return [start, end, mid].map(p => { const q = new DOMPoint(p.x, p.y).matrixTransform(matrix); return { x: q.x, y: q.y }; });
  });
  const c = await center(desktop, kaltsit);
  assert.ok(geometry.slice(0, 2).some(p => Math.hypot(p.x - b.x, p.y - b.y) < .3));
  assert.ok(geometry.slice(0, 2).some(p => Math.hypot(p.x - c.x, p.y - c.y) < 1));
  await desktop.mouse.click(geometry[2].x, geometry[2].y);
  await desktop.locator('.dossier-quote').waitFor();
  assert.ok((await desktop.locator('.dossier-id').innerText()).includes(edgeId));
  await desktop.keyboard.press('Escape');
});
await check('drag release settles at the saved anchor and history ignores decorative drift', async () => {
  const id = (await state(desktop)).visiblePeople.find(id => id !== kaltsit);
  const p = await center(desktop, id);
  await desktop.mouse.move(p.x, p.y); await desktop.mouse.down();
  await desktop.mouse.move(p.x + 32, p.y + 18, { steps: 6 }); await desktop.mouse.up();
  const anchor = (await state(desktop)).positions[id];
  await desktop.mouse.move(10, 100);
  await delay(900);
  const after = await state(desktop), q = await center(desktop, id);
  assert.deepEqual(after.positions[id], anchor);
  assert.equal(after.motion.moving, 0);
  const expected = await desktop.evaluate(({ id }) => { const s = window.relationshipAtlas.getState(), r = document.querySelector('#graph').getBoundingClientRect(); return { x: r.x + s.camera.x + s.positions[id].x * s.camera.k, y: r.y + s.camera.y + s.positions[id].y * s.camera.k }; }, { id });
  assert.ok(Math.hypot(q.x - expected.x, q.y - expected.y) < 5);
  await desktop.locator('#group-back').click(); await delay(700);
  assert.equal((await state(desktop)).groupView, null);
});
await check('pause persists, reduced motion stops the frame loop and feedback remains usable', async () => {
  await setting(desktop, 'graph-motion', false);
  const before = (await state(desktop)).motion.frameCount;
  await delay(350);
  assert.equal((await state(desktop)).motion.frameCount, before);
  await desktop.reload({ waitUntil: 'networkidle' });
  assert.equal((await state(desktop)).motion.enabled, false);
  await setting(desktop, 'graph-motion', true);
  await desktop.emulateMedia({ reducedMotion: 'reduce' });
  await delay(100);
  assert.equal((await state(desktop)).motion.running, false);
  assert.ok(await desktop.locator('#graph-motion').isDisabled());
  await desktop.locator('[data-node="g:rhodes"]').focus(); await desktop.keyboard.press('Enter');
  assert.equal((await state(desktop)).groupView.id, 'rhodes');
  assert.equal((await state(desktop)).motion.moving, 0);
  await desktop.emulateMedia({ reducedMotion: 'no-preference' });
});
await check('rapid paging converges and leaving the graph stops background work', async () => {
  await desktop.locator('#group-next').click(); await desktop.locator('#group-next').click(); await desktop.locator('#group-prev').click();
  await delay(800);
  const s = await state(desktop);
  assert.equal(s.groupView.page, 1);
  assert.equal(s.motion.moving, 0);
  assert.deepEqual(new Set(s.visiblePeople.filter(id => id !== kaltsit)), new Set(s.groupDetail.members.slice(s.groupDetail.start, s.groupDetail.start + s.groupDetail.size).map(n => n.id)));
  await desktop.locator('.site-brand').click();
  const before = (await state(desktop)).motion.frameCount;
  await delay(500);
  assert.equal((await state(desktop)).motion.running, false);
  assert.equal((await state(desktop)).motion.frameCount, before);
  assert.equal(await desktop.locator('.home-copy p').count(), 0);
  assert.ok(await desktop.locator('.portal-enter').isVisible());
  await capture(desktop, 'home');
});
await check('mobile touch keeps paging, explicit lines and motion controls usable', async () => {
  const mobile = await createPage({ width: 390, height: 844 }, true);
  await ready(mobile); await clickNode(mobile, 'g:rhodes', true); await delay(800);
  assert.equal((await state(mobile)).groupDetail.size, 4);
  await stableLabels(mobile, 'mobileNames');
  await setting(mobile, 'show-lines', true); await delay(200);
  assert.equal((await state(mobile)).showAllLines, true);
  assert.ok(await mobile.locator('.edge-hit').first().evaluate(el => getComputedStyle(el).pointerEvents === 'stroke'));
  await mobile.locator('#group-next').click(); await delay(700);
  assert.equal((await state(mobile)).groupView.page, 1);
  await setting(mobile, 'show-lines', false);
  await capture(mobile, 'mobile');
  await mobile.setViewportSize({ width: 844, height: 390 }); await delay(900);
  await capture(mobile, 'landscape');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.close();
});
await check('dense overview limits hidden edge work and has no browser errors', async () => {
  await ready(desktop);
  await desktop.locator('#expand-all').click(); await delay(800);
  const before = (await state(desktop)).motion.frameCount;
  const timings = await desktop.evaluate(() => new Promise(resolve => {
    const values = []; let previous = performance.now();
    function frame(now) { values.push(now - previous); previous = now; if (values.length < 40) requestAnimationFrame(frame); else resolve(values); }
    requestAnimationFrame(frame);
  }));
  const after = (await state(desktop)).motion.frameCount;
  assert.ok(after > before && after - before <= 35);
  assert.equal(await desktop.locator('.edge-line').evaluateAll(els => els.filter(el => +getComputedStyle(el).strokeOpacity > .1).length), 0);
  metrics.denseOverview = { people: (await state(desktop)).visiblePeople.length, browserFrameMedianMs: timings.sort((a,b) => a-b)[20], graphFrames: after - before, browserFrames: 40 };
  await capture(desktop, 'all-expanded');
  await desktop.locator('#collapse-all').click(); await delay(700); await clickNode(desktop, 'g:rhodes'); await delay(800);
  await desktop.mouse.move(10, 100); await delay(500);
  await capture(desktop, 'desktop');
  const id = (await state(desktop)).visiblePeople.find(id => id !== kaltsit), point = await center(desktop, id);
  await desktop.mouse.move(point.x, point.y); await delay(180);
  await capture(desktop, 'desktop-highlight');
  assert.deepEqual(errors, []);
});
await browser.close();
const report = { checks, errors, metrics, pass: checks.every(c => c.pass) && !errors.length };
await fs.writeFile(path.join(output, 'ui-checks.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({checks: checks.length, failed:checks.filter(c => !c.pass), errors, metrics}));
if (!report.pass) process.exitCode = 1;
