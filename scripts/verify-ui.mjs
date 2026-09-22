import { verificationReport } from './verification-output.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from './playwright.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4188';
const output = await verificationReport('ui', 'ui-checks.json');
const graphRoute = process.env.API_MODE ? '**/api/graph/**' : '**/data/graph.json';
const evidenceRoute = process.env.API_MODE ? '**/api/relationships/**' : '**/data/evidence.json';
const expectedOperatorEdges = Number(process.env.EXPECTED_OPERATOR_EDGES || 3695);
const expectedAllRootEntries = Number(process.env.EXPECTED_ALL_ROOT_ENTRIES || 21);
const checks = [], errors = [];
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const pause = (page, ms = 350) => page.waitForTimeout(ms);
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.message.slice(0, 1500) }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
  await fs.writeFile(output, JSON.stringify({ checks, errors }, null, 2));
}
async function page(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  return page;
}
const state = page => page.evaluate(() => window.relationshipAtlas.getState());
const portal = page => page.evaluate(() => window.terraPortal.getState());
const formed = page => page.waitForFunction(() => { const state = window.terraPortal?.getState(); return state && !state.forming && state.targetError < .01; });
async function ready(page, path = '/') {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.relationshipAtlas && window.terraPortal);
}
const p = await page();
await check('home, navigation, particle convergence', async () => {
  await ready(p); await formed(p);
  assert.equal((await portal(p)).page, 'home');
  assert.equal((await portal(p)).renderer, 'webgl');
  assert.ok((await portal(p)).targetError < .01);
  await p.locator('.portal-enter').click(); await pause(p, 1200);
  assert.equal((await portal(p)).page, 'factions');
  assert.equal(await p.locator('.faction-entry').count(), 21);
});
await check('particle pointer interaction, removed controls and rapid selection', async () => {
  assert.equal(await p.locator('#particle-scatter, #particle-motion').count(), 0);
  await p.locator('.faction-entry[data-enter="yan"]').hover(); await formed(p);
  assert.equal((await portal(p)).activeFaction, 'yan');
  const box = await p.locator('#emblem-canvas').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal((await portal(p)).pointerActive, true);
  await p.mouse.move(1, 1); await formed(p);
  for (let i = 0; i < 5; i++) await p.locator('#emblem-next').click();
  await formed(p); assert.equal((await portal(p)).activeFaction, 'iberia');
});
await check('faction graph scopes people and preserves global data', async () => {
  await p.locator('.faction-entry[data-enter="rhodes"]').click(); await pause(p, 1100);
  const value = await state(p); assert.equal(value.scopeFaction, 'rhodes'); assert.equal(value.visiblePeople.length, 83); assert.equal(value.nodeCount, 396); assert.equal(value.edgeCount, expectedOperatorEdges);
  assert.equal((await portal(p)).paused, true);
  const frame = (await portal(p)).frameCount; await pause(p, 300); assert.equal((await portal(p)).frameCount, frame);
});
await check('person includes all cross-faction relationships and groups', async () => {
  await p.locator('[data-shortcut="char_003_kalts"]').click(); await pause(p);
  const value = await state(p); assert.equal(value.directCount, 197); assert.ok(value.groups.some(group => group.id === 'rainbow'));
  await p.locator('#expand-all').click(); assert.equal((await state(p)).visiblePeople.length, 198);
  await p.locator('#collapse-all').click(); assert.equal((await state(p)).visiblePeople.length, 1);
});
await check('zoom, drag, tooltip, browser history preserve camera and coordinates', async () => {
  await p.locator('#zoom-in').click();
  const node = p.locator('[data-node="char_003_kalts"]'); const bounds = await node.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + 35;
  await p.mouse.move(x, y); await pause(p); assert.equal(await p.locator('#node-preview').isVisible(), true);
  await p.mouse.down(); await p.mouse.move(x + 40, y + 30, { steps: 8 }); await p.mouse.up();
  await pause(p, 150); const old = await state(p); assert.equal(old.focus, 'char_003_kalts'); assert.ok(Math.abs(old.positions.char_003_kalts.x) > 10);
  await p.locator('[data-shortcut="char_002_amiya"]').click(); await pause(p); await p.goBack(); await pause(p, 350);
  assert.deepEqual((await state(p)).camera, old.camera); assert.deepEqual((await state(p)).positions.char_003_kalts, old.positions.char_003_kalts);
  await p.locator('#home').click(); await pause(p, 1100); await p.goBack(); await pause(p, 500);
  assert.deepEqual((await state(p)).camera, old.camera);
});
await check('relationship tabs, faction search, evidence and dialog focus', async () => {
  await p.locator('#open-list').click(); await pause(p);
  assert.equal(await p.locator('.member-row').count(), 197);
  await p.locator('#member-search').fill('彩虹小队'); assert.equal(await p.locator('.member-row').count(), 8);
  await p.locator('#member-search').fill(''); await p.locator('[data-kind="awareness"]').click();
  assert.ok((await p.locator('.member-row').count()) < 197);
  await p.locator('[data-detail]').first().click(); await p.locator('.dossier-quote').waitFor();
  assert.ok((await p.locator('.dossier-status-desc').textContent()).includes('知晓'));
  await p.keyboard.press('Escape'); await pause(p, 260); assert.equal(await p.locator('#panel').evaluate(el => el.open), false);
  assert.equal(await p.evaluate(() => document.activeElement.id), 'open-list');
  await p.locator('#help').click(); await pause(p); await p.locator('#close-panel').focus(); await p.keyboard.press('Shift+Tab');
  assert.equal(await p.evaluate(() => document.querySelector('#panel').contains(document.activeElement)), true);
  await p.mouse.click(300, 250); await pause(p, 260); assert.equal(await p.locator('#panel').evaluate(el => el.open), false);
});
await check('alias search, empty state, direct-link refresh', async () => {
  await p.locator('#search').fill('缄默德克萨斯'); await p.locator('#search').press('Enter'); await pause(p);
  assert.equal((await state(p)).focus, 'char_102_texas');
  await p.reload({ waitUntil: 'networkidle' }); await pause(p); assert.equal((await state(p)).focus, 'char_102_texas');
  await p.locator('#search').fill('云迹'); await p.locator('#search').press('Enter'); await pause(p);
  assert.equal((await state(p)).directCount, 0); assert.equal(await p.locator('#empty-state').isVisible(), true);
});
await check('collaboration parent, keyboard navigation and browser history', async () => {
  await ready(p, '/#factions');
  assert.equal(await p.locator('.faction-entry').count(), 21);
  assert.equal(await p.locator('.faction-entry[data-enter="unknown"]').count(), 0);
  assert.equal(await p.locator('#directory-back').isVisible(), false);
  for (const id of ['laios', 'mujica', 'sees', 'rainbow']) assert.equal(await p.locator(`.faction-entry[data-enter="${id}"]`).count(), 0);
  const parent = p.locator('.faction-entry[data-directory="collaboration"]');
  await parent.focus(); await pause(p, 1200);
  assert.equal((await portal(p)).activeFaction, 'collaboration');
  assert.ok((await p.locator('#emblem-canvas').getAttribute('aria-label')).includes('彩虹小队'));
  assert.ok((await parent.textContent()).includes('4 小队 · 21 人'));
  await parent.press('Enter'); await pause(p);
  assert.equal((await portal(p)).directoryGroup, 'collaboration');
  assert.equal(await p.locator('#directory-title').textContent(), '联动');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'directory-title');
  assert.equal(await p.locator('.emblem-steppers').isVisible(), false);
  assert.deepEqual(await p.locator('.faction-entry').evaluateAll(links => links.map(link => link.dataset.enter)), ['laios', 'mujica', 'sees', 'rainbow']);
  await p.goBack(); await pause(p); assert.equal((await portal(p)).directoryGroup, null);
  await p.goForward(); await pause(p); assert.equal((await portal(p)).directoryGroup, 'collaboration');
});
await check('all four collaboration teams retain their graph and return path', async () => {
  for (const [id, count] of [['laios', 4], ['mujica', 5], ['sees', 4], ['rainbow', 8]]) {
    await p.locator(`.faction-entry[data-enter="${id}"]`).click(); await pause(p, 1050);
    assert.equal((await state(p)).scopeFaction, id);
    assert.equal((await state(p)).visiblePeople.length, count);
    await p.reload({ waitUntil: 'networkidle' });
    assert.equal((await state(p)).scopeFaction, id);
    await p.locator('#home').click(); await pause(p, 1050);
    assert.equal((await portal(p)).directoryGroup, 'collaboration');
    assert.equal(await p.locator('.faction-entry').count(), 4);
  }
});
await check('collaboration deep links and scope survive returning to root', async () => {
  await ready(p, '/?faction=laios&scope=all#graph');
  await p.locator('#home').click(); await pause(p, 1050);
  assert.equal((await portal(p)).directoryGroup, 'collaboration');
  assert.equal(new URL(p.url()).searchParams.get('scope'), 'all');
  await p.locator('#directory-back').click();
  assert.equal((await portal(p)).directoryGroup, null);
  assert.equal(new URL(p.url()).searchParams.get('scope'), 'all');
  assert.equal(new URL(p.url()).searchParams.has('faction'), false);
  assert.equal(await p.locator('.faction-entry').count(), expectedAllRootEntries);
});
await p.close();

const mobile = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await check('mobile menu, faction entry, viewport containment', async () => {
  await ready(mobile); await mobile.locator('#site-menu-open').click(); await mobile.locator('#site-menu [data-page="factions"]').click(); await pause(mobile, 700);
  assert.equal(await mobile.locator('#site-menu').evaluate(el => el.open), false);
  await mobile.locator('.faction-entry[data-enter="rhodes"]').click(); await pause(mobile, 700);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.equal((await state(mobile)).visiblePeople.length, 83);
  await mobile.locator('[data-shortcut="char_003_kalts"]').click(); await pause(mobile);
  assert.equal((await state(mobile)).groups.filter(g => g.expanded).length, 0);
});
await check('real touch pinch and drag, no accidental navigation', async () => {
  const cdp = await mobile.context().newCDPSession(mobile), box = await mobile.locator('#graph').boundingBox();
  const y = box.y + box.height / 2; const before = await state(mobile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y, id: 1 }, { x: 250, y, id: 2 }] });
  for (let i = 1; i <= 4; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120 - i * 8, y, id: 1 }, { x: 250 + i * 8, y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok((await state(mobile)).camera.k > before.camera.k); assert.equal((await state(mobile)).focus, before.focus);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 25, y: box.y + 60 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 70, y: box.y + 90 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.equal(await mobile.locator('#graph').evaluate(el => el.classList.contains('dragging')), false);
});
await check('mobile drawer close and toolbar accessibility', async () => {
  await mobile.locator('#open-list').click(); await pause(mobile); await mobile.locator('#tab-awareness').click();
  await mobile.locator('[data-detail]').first().click(); await mobile.locator('.dossier-quote').waitFor();
  await mobile.locator('#close-panel').tap(); await pause(mobile, 260); assert.equal(await mobile.locator('#panel').evaluate(el => el.open), false);
  for (const id of ['fit', 'reset', 'zoom-in', 'zoom-out', 'open-list']) { const r = await mobile.locator('#' + id).boundingBox(); assert.ok(r.x >= 0 && r.x + r.width <= 390 && r.y + r.height <= 844); }
});
await check('mobile horizontal operator strip uses touch scrolling', async () => {
  const cdp = await mobile.context().newCDPSession(mobile), r = await mobile.locator('#operator-shortcuts').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.width - 10, y: r.y + 30 }] });
  for (let n = 0; n < 5; n++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x + r.width - 30 - n * 40, y: r.y + 30 }] }); await pause(mobile, 30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pause(mobile, 300);
  assert.ok(await mobile.locator('#operator-shortcuts').evaluate(el => el.scrollLeft > 0));
});
await check('mobile collaboration menu, touch entry and return', async () => {
  await ready(mobile, '/#factions');
  await mobile.locator('.faction-entry[data-directory="collaboration"]').tap();
  assert.equal(await mobile.locator('.faction-entry').count(), 4);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
  await mobile.locator('.faction-entry[data-enter="mujica"]').tap(); await pause(mobile, 700);
  assert.equal((await state(mobile)).visiblePeople.length, 5);
  await mobile.locator('#home').tap(); await pause(mobile, 700);
  await mobile.locator('#directory-back').tap();
  assert.equal((await portal(mobile)).directoryGroup, null);
  assert.equal(await mobile.locator('.faction-entry').count(), 21);
});
await mobile.close();

const motion = await page({ reducedMotion: 'reduce' });
await check('reduced motion uses static particles and zero route animations', async () => {
  await ready(motion); await pause(motion, 500); assert.equal((await portal(motion)).reducedMotion, true);
  const frame = (await portal(motion)).frameCount; await pause(motion); assert.equal((await portal(motion)).frameCount, frame);
  await motion.locator('.portal-enter').click(); await motion.locator('#emblem-next').click(); await pause(motion);
  assert.equal((await portal(motion)).activeFaction, 'yan'); assert.ok((await portal(motion)).targetError < .001);
  assert.equal(await motion.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
});
await motion.close();

const fallback = await page();
await fallback.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return kind.includes('webgl') ? null : original.call(this, kind, ...args); }; });
await check('Canvas 2D fallback', async () => { await ready(fallback); await formed(fallback); assert.equal((await portal(fallback)).renderer, 'canvas2d'); assert.equal((await portal(fallback)).count, 2200); });
await fallback.close();

const failure = await page();
await check('graph load failure disables controls and retry recovers', async () => {
  await failure.route(graphRoute, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await failure.goto(base + '/#graph'); await failure.locator('#retry-data').waitFor(); assert.equal(await failure.locator('#search').isDisabled(), true);
  await failure.unroute(graphRoute); await failure.locator('#retry-data').click(); await failure.waitForFunction(() => window.relationshipAtlas); await pause(failure);
  assert.equal((await state(failure)).nodeCount, 396); assert.equal(await failure.locator('#search').isDisabled(), false);
});
await check('evidence failure retry and closing during fetch', async () => {
  await failure.locator('[data-shortcut="char_003_kalts"]').click(); await failure.locator('#open-list').click(); await pause(failure);
  await failure.route(evidenceRoute, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await failure.locator('[data-detail]').first().click(); await failure.locator('[data-retry]').waitFor();
  await failure.unroute(evidenceRoute); await failure.locator('[data-retry]').click(); await failure.locator('[data-retry]').waitFor({ state: 'hidden' }); await failure.locator('.dossier-quote').waitFor();
  await failure.locator('#close-panel').click(); await pause(failure, 250);
});
await failure.close();

const delayed = await page();
await check('late evidence response cannot reopen a closed panel', async () => {
  await delayed.route(evidenceRoute, async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue(); });
  await ready(delayed, '/?person=char_003_kalts#graph'); await delayed.locator('#open-list').click(); await pause(delayed); await delayed.locator('[data-detail]').first().click();
  await delayed.locator('#close-panel').click(); await pause(delayed, 1000); assert.equal(await delayed.locator('#panel').evaluate(el => el.open), false);
});
await delayed.close();

const imageFailure = await page();
await check('emblem failure retry and avatar fallback', async () => {
  await imageFailure.route('**/assets/emblems/rhodes.png', route => route.abort()); await ready(imageFailure);
  await imageFailure.locator('#particle-retry').waitFor();
  await imageFailure.unroute('**/assets/emblems/rhodes.png'); await imageFailure.locator('#particle-retry').click(); await formed(imageFailure);
  assert.ok((await portal(imageFailure)).targetError < .01);
  await imageFailure.route('**/avatars/char_003_kalts.webp', route => route.abort());
  await imageFailure.goto(base + '/?person=char_003_kalts#graph'); await pause(imageFailure, 650);
  assert.equal(await imageFailure.locator('[data-node="char_003_kalts"] .avatar-monogram').textContent(), '凯');
  assert.equal(await imageFailure.locator('[data-node="char_003_kalts"] image').evaluate(el => el.classList.contains('avatar-failed')), true);
});
await check('WebGL context loss exposes recovery without breaking navigation', async () => {
  await imageFailure.locator('#home').click(); await pause(imageFailure);
  await imageFailure.evaluate(() => document.querySelector('#emblem-canvas').getContext('webgl').getExtension('WEBGL_lose_context').loseContext());
  await imageFailure.locator('#particle-retry').waitFor();
  await imageFailure.locator('.faction-entry[data-enter="rhodes"]').click(); await pause(imageFailure);
  assert.equal((await state(imageFailure)).scopeFaction, 'rhodes');
});
await imageFailure.close();
await browser.close();
const result = { date: new Date().toISOString(), checks, errors, pass: checks.every(check => check.pass) && errors.length === 0 };
await fs.writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ checks: checks.length, failed: checks.filter(check => !check.pass), errors }));
if (!result.pass) process.exitCode = 1;
