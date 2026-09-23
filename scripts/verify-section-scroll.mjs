import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, webkit } from './playwright.mjs';
import { installGameFixture } from './game-ui-fixture.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5178';
const engine = process.env.BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const output = await verificationDirectory('section-scroll');
const browser = await ({ chromium, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--enable-unsafe-swiftshader'] } : {}) });
const checks = [], errors = [];
async function check(name, run) {
  try { await run(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) {
    for (const context of browser.contexts()) for (const p of context.pages()) console.error(await p.evaluate(() => ({ url: location.href, page: window.terraPortal?.getState().page, scroll: document.querySelector('#game-workspace')?.scrollTop, transition: document.documentElement.dataset.sectionTransitioning, dialogs: document.querySelectorAll('dialog[open]').length })));
    throw error;
  }
}
async function page(options = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  p.setDefaultTimeout(10000);
  p.on('pageerror', error => errors.push(error.message));
  await p.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
  await installGameFixture(p);
  return p;
}
async function settled(p, section) {
  await p.waitForFunction(section => section === 'game' ? !!document.querySelector('#game-workspace') : window.terraPortal?.getState().page === section, section);
  await p.waitForFunction(() => !document.documentElement.dataset.sectionTransitioning && !document.documentElement.dataset.sectionLoading &&
    !document.getAnimations().some(animation => ['running', 'pending'].includes(animation.playState)));
}
async function ready(p, path = '/?scope=all#home') {
  await p.goto(base + path);
  await p.waitForFunction(() => window.terraPortal?.getState().renderer && document.querySelectorAll('.faction-entry').length > 10);
}
async function wheel(p, selector, deltaY) {
  const box = await p.locator(selector).boundingBox();
  await p.mouse.move(selector === '#game-workspace' ? box.x + 8 : box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, deltaY);
}
async function swipe(p, x, y, dx, dy) {
  if (engine === 'chromium') {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] });
      await p.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    // WebKit 的 Playwright 接口不提供真实拖动；这里仅验证 TouchEvent 分派，原生滚动由 Chromium 覆盖。
    await p.evaluate(({ x, y, dx, dy }) => {
      const target = document.elementFromPoint(x, y);
      const send = (type, progress) => {
        const touch = { identifier: 1, target, clientX: x + dx * progress, clientY: y + dy * progress };
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
        target.dispatchEvent(event);
      };
      send('touchstart', 0);
      for (let i = 1; i <= 10; i++) send('touchmove', i / 10);
      send('touchend', 1);
    }, { x, y, dx, dy });
  }
}

try {
  const desktop = await page();
  await ready(desktop);
  const origin = await desktop.evaluate(() => performance.timeOrigin);
  await check('desktop small wheel deltas accumulate; both sections remain during the transition', async () => {
    await desktop.locator('.portal-enter').hover();
    for (let i = 0; i < 6; i++) await desktop.mouse.wheel(0, 10);
    await desktop.waitForFunction(() => window.terraPortal.getState().page === 'factions');
    assert.equal(await desktop.locator('#home-page').evaluate(node => node.hidden), false);
    assert.equal(await desktop.locator('#home-page').evaluate(node => node.inert), true);
    assert.equal(await desktop.locator('#factions-page').evaluate(node => node.hidden), false);
    assert.notEqual(await desktop.locator('#factions-page').evaluate(node => getComputedStyle(node).transform), 'none');
    // 动画结束后仍到来的同一串惯性事件不得继续进入游戏。
    for (let i = 0; i < 16; i++) { await desktop.mouse.wheel(0, 8); await desktop.waitForTimeout(50); }
    await settled(desktop, 'factions');
    assert.equal(await desktop.locator('#home-page').evaluate(node => node.hidden), true);
  });
  await check('directory scrolls natively; a new upward gesture at its top returns home', async () => {
    await wheel(desktop, '#faction-directory', 350);
    await desktop.waitForFunction(() => document.querySelector('#faction-directory').scrollTop > 0);
    await wheel(desktop, '#faction-directory', -1500);
    await desktop.mouse.wheel(0, -100);
    await desktop.waitForFunction(() => document.querySelector('#faction-directory').scrollTop === 0);
    assert.equal(await desktop.evaluate(() => window.terraPortal.getState().page), 'factions');
    await desktop.waitForTimeout(220);
    await wheel(desktop, '#faction-directory', -100);
    await settled(desktop, 'home');
  });
  await check('desktop home, factions and game support forward/back navigation without document reload', async () => {
    await wheel(desktop, '.portal-enter', 120);
    await settled(desktop, 'factions');
    await desktop.waitForTimeout(220);
    await wheel(desktop, '#emblem-next', 120);
    await settled(desktop, 'game');
    assert.equal(await desktop.evaluate(() => !!window.terraPortal || !!window.relationshipAtlas), false);
    await desktop.waitForFunction(() => !document.querySelector('.game-load-state'));
    const save = await desktop.evaluate(() => localStorage.getItem('arknights-games-v2'));
    assert.ok(save);
    await desktop.locator('#game-workspace').evaluate(node => { node.scrollTop = 250; });
    if (await desktop.locator('#game-workspace').evaluate(node => node.scrollTop > 0)) {
      await wheel(desktop, '#game-workspace', -1500);
      await desktop.mouse.wheel(0, -100);
      await desktop.waitForFunction(() => document.querySelector('#game-workspace').scrollTop === 0);
      assert.match(desktop.url(), /\/game\/$/);
    }
    await desktop.waitForTimeout(220);
    await wheel(desktop, '.game-title-row', -120);
    await settled(desktop, 'factions');
    assert.match(desktop.url(), /scope=all#factions$/);
    assert.equal(await desktop.evaluate(() => performance.timeOrigin), origin);
    await desktop.goBack(); await settled(desktop, 'game');
    await desktop.waitForFunction(() => !document.querySelector('.game-load-state'));
    assert.equal(await desktop.evaluate(() => localStorage.getItem('arknights-games-v2')), save);
    await desktop.goForward(); await settled(desktop, 'factions');
    await desktop.screenshot({ path: `${output}/${engine}-desktop.png` });
  });
  await check('graph wheel zoom remains independent of section navigation', async () => {
    await desktop.locator('#all-operators').click(); await settled(desktop, 'graph');
    const before = await desktop.evaluate(() => window.relationshipAtlas.getState().camera);
    await wheel(desktop, '#graph', -120);
    assert.equal(await desktop.evaluate(() => window.terraPortal.getState().page), 'graph');
    assert.notDeepEqual(await desktop.evaluate(() => window.relationshipAtlas.getState().camera), before);
  });
  const mobile = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ready(mobile);
  await check('cancelled, short and multi-touch gestures do not change sections', async () => {
    await mobile.evaluate(() => {
      const target = document.querySelector('#particle-stage');
      const point = (y, identifier = 1) => ({ identifier, target, clientX: 190, clientY: y });
      const send = (type, touches) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: touches });
        target.dispatchEvent(event);
      };
      send('touchstart', [point(280)]); send('touchmove', [point(260)]); send('touchend', []);
      send('touchstart', [point(280)]); send('touchcancel', []); send('touchmove', [point(140)]);
      send('touchstart', [point(280)]); send('touchstart', [point(280), point(300, 2)]);
      send('touchmove', [point(140)]); send('touchend', []);
    });
    assert.equal(await mobile.evaluate(() => window.terraPortal.getState().page), 'home');
  });
  await check('mobile canvas accepts vertical swipes and ignores horizontal gestures', async () => {
    await swipe(mobile, 195, 280, 110, 12);
    assert.equal(await mobile.evaluate(() => window.terraPortal.getState().page), 'home');
    await swipe(mobile, 195, 320, 5, -140);
    await settled(mobile, 'factions');
    await swipe(mobile, 195, 220, 5, 140);
    await settled(mobile, 'home');
    await swipe(mobile, 195, 320, 0, -140);
    await settled(mobile, 'factions');
  });
  await check('mobile list retains native scrolling and hands a new edge gesture to the page', async () => {
    const box = await mobile.locator('#faction-directory').boundingBox();
    await swipe(mobile, box.x + box.width / 2, box.y + box.height * .8, 0, -80);
    if (engine === 'chromium') await mobile.waitForFunction(() => document.querySelector('#faction-directory').scrollTop > 0);
    assert.equal(await mobile.evaluate(() => window.terraPortal.getState().page), 'factions');
    await mobile.waitForTimeout(600);
    await mobile.locator('#faction-directory').evaluate(node => { node.scrollTop = 0; });
    await swipe(mobile, box.x + box.width / 2, box.y + 25, 0, 100);
    await settled(mobile, 'home');
  });
  await check('mobile game returns to factions, dialogs block swipes and taps still navigate', async () => {
    await swipe(mobile, 195, 320, 0, -140); await settled(mobile, 'factions');
    await swipe(mobile, 195, 280, 0, -140); await settled(mobile, 'game');
    await mobile.waitForFunction(() => !document.querySelector('.game-load-state'));
    await mobile.locator('#game-workspace').evaluate(node => { node.scrollTop = 0; });
    await swipe(mobile, 195, 200, 0, 150); await settled(mobile, 'factions');
    await mobile.locator('#site-menu-open').tap();
    await swipe(mobile, 190, 240, 0, 120);
    assert.equal(await mobile.evaluate(() => window.terraPortal.getState().page), 'factions');
    await mobile.locator('#site-menu-close').tap();
    await mobile.waitForTimeout(420);
    await mobile.screenshot({ path: `${output}/${engine}-mobile.png` });
    await mobile.locator('#all-operators').tap(); await settled(mobile, 'graph');
  });
  await check('reduced motion, rapid navigation and the transition fallback remain usable', async () => {
    await desktop.emulateMedia({ reducedMotion: 'reduce' });
    await desktop.locator('.site-nav [data-page="home"]').click();
    await wheel(desktop, '.portal-enter', 120); await settled(desktop, 'factions');
    assert.equal(await desktop.locator('#home-page').evaluate(node => node.hidden), true);
    await wheel(desktop, '#emblem-next', -120); await settled(desktop, 'home');
    await desktop.emulateMedia({ reducedMotion: 'no-preference' });
    await desktop.locator('.site-nav [data-page="factions"]').click();
    await desktop.locator('.site-nav [data-page="home"]').click();
    await settled(desktop, 'home');
    assert.equal(await desktop.locator('#factions-page').evaluate(node => node.hidden || node.inert), true);
    await desktop.evaluate(() => { document.startViewTransition = undefined; });
    await desktop.locator('.site-nav a[href="/game/"]').click(); await settled(desktop, 'game');
    await wheel(desktop, '.game-title-row', -120); await settled(desktop, 'factions');
  });
  await check('a newer section choice cancels a game entry that is still loading', async () => {
    const slow = await page();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const gameModule = /\/(?:src\/game\/GameApp\.vue|assets\/GameApp-[^/?]+\.js)/;
    await slow.route(gameModule, async route => { await gate; await route.continue(); });
    try {
      await ready(slow, '/?scope=all#factions');
      const requested = slow.waitForRequest(request => gameModule.test(request.url()));
      await slow.locator('.site-nav a[href="/game/"]').click();
      await requested;
      await slow.locator('.site-nav [data-page="home"]').click();
      release();
      await slow.waitForLoadState('networkidle');
      await settled(slow, 'home');
      assert.equal(await slow.locator('#game-workspace').count(), 0);
    } finally { release(); await slow.close(); }
  });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${output}/${engine}.json`, JSON.stringify({ engine, checks, errors }, null, 2));
  await browser.close();
}
