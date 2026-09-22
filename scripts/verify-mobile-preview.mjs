import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from './playwright.mjs';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5177';
const engine = process.env.BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'BROWSER must be chromium or webkit');
const graph = JSON.parse(await readFile(new URL('../data/npc/graph.json', import.meta.url), 'utf8'));
const output = new URL('../.runtime/verification/mobile-preview/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await ({ chromium, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--enable-unsafe-swiftshader'] } : {}) });
const result = { engine, checks: [], documents: [], sockets: [], errors: [] };
const state = page => page.evaluate(() => ({ timeOrigin: performance.timeOrigin, ...window.terraPortal.getState() }));
const formed = page => page.waitForFunction(() => {
  const state = window.terraPortal?.getState();
  return state?.motionProfile && !state.forming && state.targetError < .01;
});
let releaseAssets;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => {
    // history.replaceState 也会触发 framenavigated，只有文档请求才代表整页重载。
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) result.documents.push(request.url());
  });
  page.on('websocket', socket => result.sockets.push(socket.url()));
  const assetsReady = new Promise(resolve => { releaseAssets = resolve; });
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/graph/') return route.fulfill({ json: graph });
    if (path === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, registrationEnabled: false } });
    if (path.startsWith('/api/')) return route.fulfill({ status: 403, json: { detail: 'Isolated mobile preview verification' } });
    if (['script', 'stylesheet'].includes(request.resourceType())) await assetsReady;
    return route.continue();
  });
  const response = await page.goto(`${base}/#factions`, { waitUntil: 'commit' });
  assert.ok(response.ok());
  assert.doesNotMatch(await response.text(), /\/@vite\/client/, 'Use the production preview, not the dev server');
  await page.waitForFunction(() => document.body);
  result.initialPaint = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    mounted: document.querySelector('#app').childElementCount > 0,
  }));
  assert.deepEqual(result.initialPaint, { background: 'rgb(6, 8, 9)', colorScheme: 'dark', mounted: false });
  result.checks.push('Dark first paint while application scripts and styles are delayed');
  releaseAssets();
  await formed(page);
  result.before = await state(page);
  // 连续观察多个入场周期，不能在落定后自行重播。
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    assert.equal((await state(page)).forming, false);
  }
  await context.setOffline(true);
  await page.waitForTimeout(1500);
  await context.setOffline(false);
  await page.waitForTimeout(1500);
  for (const viewport of [{ width: 390, height: 760 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const current = await state(page);
    assert.equal(current.forming, false);
    assert.equal(current.activeFaction, result.before.activeFaction);
  }
  result.after = await state(page);
  assert.equal(result.after.timeOrigin, result.before.timeOrigin);
  assert.ok(result.after.frameCount > result.before.frameCount);
  assert.equal(result.documents.length, 1);
  assert.deepEqual(result.sockets, []);
  result.checks.push('Idle, network reconnect and viewport changes preserve the same page and emblem');
  await page.locator('#emblem-next').tap();
  await page.waitForFunction(previous => {
    const state = window.terraPortal.getState();
    return state.activeFaction !== previous && state.forming;
  }, result.before.activeFaction);
  await formed(page);
  assert.equal((await state(page)).timeOrigin, result.before.timeOrigin);
  assert.deepEqual(result.errors, []);
  await page.screenshot({ path: new URL(`${engine}.png`, output).pathname });
  result.checks.push('Explicit emblem switching still plays and settles');
  console.log(JSON.stringify(result, null, 2));
} finally {
  releaseAssets?.();
  await writeFile(new URL(`${engine}.json`, output), JSON.stringify(result, null, 2));
  await browser.close();
}
