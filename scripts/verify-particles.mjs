import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from './playwright.mjs';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5174';
const graph = JSON.parse(await readFile(new URL('../data/npc/graph.json', import.meta.url), 'utf8'));
const { icons } = JSON.parse(await readFile(new URL('../frontend/public/assets/emblems.json', import.meta.url), 'utf8'));
const output = new URL('../.runtime/verification/particles/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const results = [], errors = [];
const state = page => page.evaluate(() => window.terraPortal.getState());
const formed = page => page.waitForFunction(() => { const state = window.terraPortal?.getState(); return state && !state.forming && state.targetError < .01; });
async function check(name, run) { await run(); results.push(name); console.log(`PASS ${name}`); }
async function open(options = {}, path = '/#factions', fallback = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/graph/') return route.fulfill({ json: graph });
    if (path === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, registrationEnabled: false } });
    return route.fulfill({ status: 403, json: { detail: 'Isolated particle verification' } });
  });
  if (fallback) await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return kind.includes('webgl') ? null : getContext.call(this, kind, ...args); };
  });
  await page.goto(base + path);
  await page.waitForFunction(() => window.terraPortal?.getState().renderer);
  return page;
}

try {
  const desktop = await open();
  await check('particles visibly follow the triangular emblem from outside the canvas with short trails', async () => {
    const metrics = await desktop.evaluate(async () => {
      const { ParticleField, sampleEmblem } = await import('/src/atlas/particles.js');
      const wrapper = document.createElement('div'), canvas = document.createElement('canvas');
      wrapper.style.cssText = 'position:fixed;left:-1000px;top:0;width:800px;height:700px';
      canvas.style.cssText = 'width:100%;height:100%';
      wrapper.append(canvas); document.body.append(wrapper);
      const field = new ParticleField(canvas);
      try {
        field.pause();
        const sample = await sampleEmblem('/assets/emblems/rhodes.png', field.count);
        field.setEmblem(sample, { id: 'rhodes' });
        const launchedAtEdges = field.positions.every((coordinate, i) => coordinate === field.origins[i]);
        const firstDelays = field.arrivalDelays.slice();
        const edges = [0, 0, 0, 0];
        const outside = Array.from({ length: field.count }, (_, i) => {
          const index = i * 3, perspective = 1 + field.positions[index + 2] * .28;
          const x = field.positions[index] / perspective, y = field.positions[index + 1] / perspective;
          if (Math.abs(x) * field.scale > field.width / 2) { edges[x < 0 ? 0 : 1]++; return true; }
          if (Math.abs(y) * field.scale > field.height / 2) { edges[y < 0 ? 2 : 3]++; return true; }
          return false;
        }).every(Boolean);
        const stages = [{ milliseconds: 0, ...field.getState() }];
        let longestTrail = 0;
        for (let frame = 1; frame <= 150; frame++) {
          field.step(frame * 16.667, 1);
          if ([18, 36, 60, 108, 150].includes(frame)) {
            field.draw();
            let visibleInFlight = 0;
            for (let i = 0; i < field.count; i++) {
              const index = i * 3, perspective = 1 + field.positions[index + 2] * .28;
              if (field.styles[index + 1] > 0 && Math.abs(field.positions[index] / perspective) * field.scale < field.width / 2 && Math.abs(field.positions[index + 1] / perspective) * field.scale < field.height / 2 && Math.hypot(field.positions[index] - field.targets[index], field.positions[index + 1] - field.targets[index + 1]) > .03) visibleInFlight++;
            }
            for (let i = 0; i < field.laserCount; i++) {
              const offset = i * 6;
              longestTrail = Math.max(longestTrail, Math.hypot(...[0, 1, 2].map(axis => field.laserPositions[offset + axis] - field.laserPositions[offset + 3 + axis])));
            }
            stages.push({ milliseconds: frame * 16.667, visibleInFlight, ...field.getState() });
          }
        }
        const renderError = field.gl.getError();
        field.setEmblem(sample, { id: 'rhodes', replay: true });
        const varied = field.arrivalDelays.some((delay, i) => Math.abs(delay - firstDelays[i]) > 100);
        field.setReducedMotion(true);
        return { outside, edges, launchedAtEdges, longestTrail, varied, stages, renderError, reduced: field.getState() };
      } finally { field.dispose(); wrapper.remove(); }
    });
    assert.equal(metrics.outside, true);
    assert.equal(metrics.launchedAtEdges, true);
    assert.ok(metrics.edges[0] > 0 && metrics.edges[1] > 0 && metrics.edges[3] > 0);
    assert.ok(metrics.stages[1].visibleInFlight > 100);
    assert.ok(metrics.stages[2].visibleInFlight > 100);
    assert.ok(metrics.longestTrail > 0 && metrics.longestTrail <= .071);
    assert.equal(metrics.varied, true);
    assert.equal(metrics.renderError, 0);
    assert.equal(metrics.stages[0].printedCount, 0);
    assert.ok(metrics.stages[1].printedCount > 0);
    assert.ok(metrics.stages[1].laserCount > 0 && metrics.stages[1].laserCount <= 96);
    assert.equal(metrics.stages[3].forming, true);
    assert.equal(metrics.stages[4].forming, false);
    for (let i = 1; i < metrics.stages.length; i++) assert.ok(metrics.stages[i].printedCount >= metrics.stages[i - 1].printedCount);
    assert.equal(metrics.stages.at(-1).printedCount, 5000);
    assert.equal(metrics.stages.at(-1).laserCount, 0);
    assert.equal(metrics.stages.at(-1).visibleInFlight, 0);
    assert.ok(metrics.stages.at(-1).targetError < .01);
    assert.equal(metrics.reduced.forming, false);
    assert.equal(metrics.reduced.printedCount, 5000);
    assert.equal(metrics.reduced.laserCount, 0);
    await writeFile(new URL('formation.json', output), JSON.stringify(metrics, null, 2));
  });
  await check('all verified emblems have finite, visible flights and settle across distinct motion families', async () => {
    const metrics = await desktop.evaluate(async icons => {
      const { ParticleField, sampleEmblem } = await import('/src/atlas/particles.js');
      const wrapper = document.createElement('div'), canvas = document.createElement('canvas');
      wrapper.style.cssText = 'position:fixed;left:-1000px;top:0;width:800px;height:700px';
      canvas.style.cssText = 'width:100%;height:100%';
      wrapper.append(canvas); document.body.append(wrapper);
      const field = new ParticleField(canvas), results = [];
      try {
        field.pause();
        for (const icon of icons) {
          if (!icon.file || ['laios', 'mujica'].includes(icon.id)) continue;
          const sample = await sampleEmblem('/' + icon.file, field.count);
          field.setEmblem(sample, { id: icon.id });
          let outside = 0, visibleInFlight = 0;
          for (let i = 0; i < field.count; i++) {
            const j = i * 3, perspective = 1 + field.origins[j + 2] * .28;
            if (Math.abs(field.origins[j] / perspective) * field.scale > field.width / 2 || Math.abs(field.origins[j + 1] / perspective) * field.scale > field.height / 2) outside++;
          }
          for (let frame = 1; frame <= 150; frame++) {
            field.step(frame * 16.667, 1);
            if (frame === 36) {
              field.draw();
              for (let i = 0; i < field.count; i++) {
                const j = i * 3, perspective = 1 + field.positions[j + 2] * .28;
                if (field.styles[j + 1] > 0 && Math.abs(field.positions[j] / perspective) * field.scale < field.width / 2 && Math.abs(field.positions[j + 1] / perspective) * field.scale < field.height / 2 && Math.hypot(field.positions[j] - field.targets[j], field.positions[j + 1] - field.targets[j + 1]) > .03) visibleInFlight++;
              }
            }
          }
          const finite = [field.positions, field.origins, field.flightControl1, field.flightControl2].every(array => array.every(Number.isFinite));
          const settled = field.getState();
          field.setEmblem(sample, { id: icon.id });
          results.push({ id: icon.id, outside, finite, visibleInFlight, duplicateRestarted: field.getState().forming, ...settled });
        }
        return results;
      } finally { field.dispose(); wrapper.remove(); }
    }, icons);
    for (const metric of metrics) {
      assert.equal(metric.outside, metric.count, metric.id);
      assert.equal(metric.finite, true, metric.id);
      assert.ok(metric.visibleInFlight > 100, metric.id);
      assert.ok(metric.targetError < .01, metric.id);
      assert.equal(metric.forming, false, metric.id);
      assert.equal(metric.duplicateRestarted, false, metric.id);
      assert.equal(metric.laserCount, 0, metric.id);
      assert.notEqual(metric.motionProfile, 'sweep', metric.id);
    }
    assert.ok(new Set(metrics.map(metric => metric.motionProfile)).size >= 8);
    await writeFile(new URL('emblem-profiles.json', output), JSON.stringify(metrics, null, 2));
  });
  await formed(desktop);
  await check('particle surface receives repeated pointer entry through the content layer', async () => {
    assert.equal((await state(desktop)).count, 5000);
    assert.equal(await desktop.locator('#particle-scatter, #particle-motion, .particle-controls').count(), 0);
    const box = await desktop.locator('#emblem-canvas').boundingBox();
    const scale = Math.min(box.width * .72, box.height * .7);
    const x = box.x + box.width / 2 - scale * .18, y = box.y + box.height / 2 + scale * .3;
    assert.equal(await desktop.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y }), 'particle-stage');
    for (let i = 0; i < 3; i++) {
      await desktop.mouse.move(x, y);
      await desktop.waitForFunction(() => window.terraPortal.getState().pointerActive && window.terraPortal.getState().targetError > .01);
      await desktop.locator('#emblem-next').hover();
      assert.equal((await state(desktop)).pointerActive, false);
      await formed(desktop);
    }
  });
  await check('right-click targets a regular page element without suppressing its native menu', async () => {
    const box = await desktop.locator('#emblem-canvas').boundingBox();
    await desktop.evaluate(() => {
      window.__particleContextMenu = null;
      document.addEventListener('contextmenu', event => {
        window.__particleContextMenu = { tag: event.target.tagName, id: event.target.id, prevented: event.defaultPrevented, trusted: event.isTrusted };
      }, { once: true });
    });
    await desktop.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    assert.deepEqual(await desktop.evaluate(() => window.__particleContextMenu), { tag: 'DIV', id: 'particle-stage', prevented: false, trusted: true });
    await desktop.keyboard.press('Escape');
    await desktop.mouse.move(1, 1);
    await formed(desktop);
  });
  await check('keyboard and rapid faction switching preserve the last selection', async () => {
    await desktop.locator('#emblem-next').focus(); await desktop.keyboard.press('Enter');
    await desktop.waitForFunction(() => window.terraPortal.getState().activeFaction === 'yan' && window.terraPortal.getState().forming);
    await desktop.waitForTimeout(550);
    await desktop.screenshot({ path: new URL('desktop-gathering.png', output).pathname });
    await desktop.locator('#emblem-next').click();
    await desktop.locator('#emblem-prev').click();
    await formed(desktop);
    assert.equal((await state(desktop)).activeFaction, 'yan');
    await desktop.locator('#emblem-prev').click(); await formed(desktop);
    await desktop.mouse.move(1, 1);
    await desktop.screenshot({ path: new URL('desktop.png', output).pathname });
  });
  await check('graph pause, direct-link initialization and return recover animation', async () => {
    await desktop.goto(`${base}/?faction=rhodes#graph`);
    await desktop.waitForFunction(() => window.terraPortal?.getState().renderer);
    const before = await state(desktop); assert.equal(before.paused, true);
    await desktop.waitForTimeout(180); assert.equal((await state(desktop)).frameCount, before.frameCount);
    await desktop.locator('#home').click(); await formed(desktop);
    assert.equal((await state(desktop)).paused, false);
    const link = desktop.locator('.faction-entry[data-directory="collaboration"]');
    await link.click();
    assert.equal(await desktop.locator('.emblem-steppers').isVisible(), false);
    await desktop.locator('#directory-back').click();
    assert.equal(await desktop.locator('.emblem-steppers').isVisible(), true);
  });
  await desktop.close();

  await check('entering operators from home immediately replays the cached emblem on desktop and mobile', async () => {
    const starts = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await open({ viewport }, '/#home');
      for (let visit = 0; visit < 2; visit++) {
        await formed(page);
        const entry = page.locator('a[data-page="factions"]:visible').first();
        await entry.evaluate(link => link.addEventListener('click', () => { window.__emblemEntryAt = performance.now(); }, { once: true }));
        await entry.click();
        await page.waitForFunction(() => window.terraPortal.getState().page === 'factions' && window.terraPortal.getState().forming, null, { timeout: 500 });
        await page.waitForFunction(() => window.terraPortal.getState().laserCount > 0, null, { timeout: 500 });
        const elapsed = await page.evaluate(() => performance.now() - window.__emblemEntryAt);
        assert.ok(elapsed < 500, `Animation started after ${elapsed} ms`);
        starts.push({ viewport, visit, elapsed });
        await formed(page);
        if (!visit) await page.locator('a[data-page="home"]:visible').first().evaluate(link => link.click());
      }
      await page.close();
    }
    await writeFile(new URL('home-replay.json', output), JSON.stringify(starts, null, 2));
  });

  for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['small-mobile', { width: 320, height: 667 }], ['landscape', { width: 844, height: 390 }]]) {
    await check(`${name}: controls fit and touch interaction releases`, async () => {
      const page = await open({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      await formed(page);
      assert.equal((await state(page)).count, name === 'landscape' ? 1200 : 2400);
      for (const id of ['emblem-prev', 'emblem-next', 'enter-faction']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      }
      const layout = await page.evaluate(() => ({ caption: document.querySelector('.emblem-caption').getBoundingClientRect().toJSON(), directory: document.querySelector('.faction-directory').getBoundingClientRect().toJSON(), width: document.documentElement.scrollWidth }));
      assert.equal(layout.width, viewport.width);
      assert.ok(layout.caption.bottom <= layout.directory.top || layout.caption.right <= layout.directory.left);
      const box = await page.locator('#emblem-canvas').boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal((await state(page)).pointerActive, false);
      const cdp = await page.context().newCDPSession(page);
      const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, y: touch.y + Math.min(90, box.height * .4) }] });
      // 在终点停住后抬手，避免瞬移式合成滑动使浏览器吞掉紧接着的点击。
      await page.waitForTimeout(200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      assert.equal((await state(page)).page, 'factions', 'Dragging particles must not trigger section navigation');
      assert.equal((await state(page)).pointerActive, false);
      await formed(page);
      await page.locator('#emblem-next').tap();
      await page.waitForFunction(() => { const state = window.terraPortal.getState(); return state.laserCount > 0 && state.printedCount < state.count; });
      await page.waitForTimeout(250);
      await page.screenshot({ path: new URL(`${name}-printing.png`, output).pathname });
      await formed(page);
      assert.equal((await state(page)).activeFaction, 'yan');
      await page.locator('#emblem-prev').tap(); await formed(page);
      await page.screenshot({ path: new URL(`${name}.png`, output).pathname });
      await page.close();
    });
  }
  await check('system reduced motion stays static and can resume dynamically', async () => {
    const page = await open({ reducedMotion: 'reduce' });
    await formed(page); const frame = (await state(page)).frameCount;
    await page.waitForTimeout(200); assert.equal((await state(page)).frameCount, frame);
    await page.locator('#emblem-next').click(); await formed(page);
    assert.equal((await state(page)).forming, false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(frame => window.terraPortal.getState().frameCount > frame, frame);
    await page.close();
  });
  await check('Canvas 2D fallback flies with trails and keeps pointer interactions', async () => {
    const page = await open({}, '/#factions', true);
    await page.waitForFunction(() => window.terraPortal.getState().laserCount > 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: new URL('canvas-printing.png', output).pathname });
    await formed(page); assert.equal((await state(page)).renderer, 'canvas2d'); assert.equal((await state(page)).count, 2200);
    const box = await page.locator('#emblem-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await state(page)).pointerActive, true);
    await page.close();
  });
  assert.deepEqual(errors, []);
  await writeFile(new URL('results.json', output), JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
