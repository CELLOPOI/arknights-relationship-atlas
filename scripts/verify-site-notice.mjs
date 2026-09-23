import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from './playwright.mjs';
import { installGameFixture } from './game-ui-fixture.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5178';
const output = await verificationDirectory('site-notice');
const storageKey = 'atlas:site-notice:acknowledged';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const checks = [], errors = [];
const longNotice = { ...siteNotice, version: 'test-long', paragraphs: Array.from({ length: 18 }, (_, index) => `测试段落 ${index + 1}。这段文字只用于验证长篇说明的滚动与阅读确认，不作为网站的正式正文。通过键盘、鼠标或触摸滚动至正文末尾后，才可以确认。`) };

async function page(options = {}, notice) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...options });
  p.setDefaultTimeout(10000);
  p.on('pageerror', error => errors.push(error.message));
  await p.addInitScript(() => {
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() {
      showModal.call(this);
      if (this.id === 'site-notice-dialog') window.__noticeOpenedAt = performance.now();
    };
  });
  await installGameFixture(p);
  if (notice) await p.route('**/src/content/site-notice.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `export const siteNotice = ${JSON.stringify(notice)};` }));
  return p;
}
const modal = p => p.locator('#site-notice-dialog');
const confirm = p => p.locator('.site-notice-confirm');
async function ready(p, path = '/') {
  await p.goto(base + path);
  await modal(p).waitFor({ state: 'visible' });
  await p.evaluate(() => document.fonts.ready);
}
async function check(name, fn) {
  await fn(); checks.push(name); console.log(`PASS ${name}`);
}
async function contained(p) {
  const size = await modal(p).boundingBox(), viewport = p.viewportSize();
  assert.ok(size.x >= 0 && size.y >= 0 && size.x + size.width <= viewport.width && size.y + size.height <= viewport.height);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await confirm(p).isVisible(), true);
}
async function locked(p) {
  await p.keyboard.press('Escape');
  await p.mouse.click(4, 4);
  await p.keyboard.press('/');
  assert.equal(await modal(p).isVisible(), true);
  assert.equal(await modal(p).evaluate(el => el.contains(document.activeElement)), true);
}

try {
  await check('short notice, dismissal guards, acknowledgement, persistence and manual reopening', async () => {
    const p = await page({ reducedMotion: 'no-preference' });
    await ready(p);
    assert.equal(await confirm(p).isDisabled(), true);
    assert.match(await confirm(p).innerText(), /^我已知晓（[1-5]s）$/);
    await p.screenshot({ path: `${output}/desktop-countdown.png` });
    // 即使人为分派点击，也必须同时满足倒计时和阅读条件。
    await confirm(p).dispatchEvent('click');
    assert.equal(await modal(p).isVisible(), true);
    await p.waitForFunction(() => document.querySelector('.site-notice-confirm').textContent.includes('（1s）'));
    assert.equal(await confirm(p).isDisabled(), true);
    await p.waitForFunction(() => !document.querySelector('.site-notice-confirm').disabled);
    assert.ok(await p.evaluate(() => performance.now() - window.__noticeOpenedAt >= 5000), 'Confirmation must wait at least five seconds after opening');
    assert.equal(await confirm(p).innerText(), '我已知晓');
    assert.equal(await p.locator('#site-notice-heading').innerText(), '站点说明');
    assert.equal(await p.locator('.site-notice-project').getAttribute('href'), siteNotice.project.url);
    assert.equal(await p.locator('.site-notice-project').getAttribute('target'), '_blank');
    await locked(p);
    await contained(p);
    await p.screenshot({ path: `${output}/desktop-short.png` });
    await p.reload();
    await modal(p).waitFor({ state: 'visible' });
    assert.equal(await confirm(p).isDisabled(), true);
    assert.match(await confirm(p).innerText(), /^我已知晓（[1-5]s）$/);
    await confirm(p).click();
    await modal(p).waitFor({ state: 'hidden' });
    assert.equal(await p.evaluate(key => localStorage.getItem(key), storageKey), siteNotice.version);
    await p.reload();
    assert.equal(await modal(p).isVisible(), false);
    for (const path of ['/#factions', '/game/', '/sources/']) {
      await p.goto(base + path);
      await p.locator('.site-notice-entry:visible').first().waitFor();
      assert.equal(await modal(p).isVisible(), false);
      const entry = p.locator('.site-notice-entry:visible').first();
      await entry.click();
      assert.equal(await confirm(p).isEnabled(), true);
      assert.equal(await confirm(p).innerText(), '我已知晓');
      await confirm(p).click();
      await modal(p).waitFor({ state: 'hidden' });
      assert.equal(await entry.evaluate(el => el === document.activeElement), true);
      if (path === '/game/') {
        for (const width of [1024, 800]) {
          await p.setViewportSize({ width, height: 900 });
          assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        await p.setViewportSize({ width: 1440, height: 900 });
      }
    }
    const saved = await p.context().storageState();
    const returning = await page({ storageState: saved });
    await returning.goto(base + '/game/');
    await returning.locator('.site-notice-entry:visible').first().waitFor();
    assert.equal(await modal(returning).isVisible(), false);
    await returning.close(); await p.close();
  });

  for (const mobile of [false, true]) await check(`${mobile ? 'touch' : 'keyboard and wheel'} reading gate, reload, resize and remembered completion`, async () => {
    const p = await page(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}, longNotice);
    await ready(p, '/?person=char_002_amiya#graph');
    const body = p.locator('.site-notice-body');
    await locked(p);
    assert.equal(await confirm(p).isDisabled(), true);
    await contained(p);
    await p.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-long.png` });
    if (mobile) {
      const cdp = await p.context().newCDPSession(p), box = await body.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height * .7;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 25 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await body.hover(); await p.mouse.wheel(0, 220);
    }
    await p.waitForFunction(() => document.querySelector('.site-notice-body').scrollTop > 0);
    assert.equal(await confirm(p).isDisabled(), true);
    await p.reload(); await modal(p).waitFor({ state: 'visible' });
    assert.equal(await confirm(p).isDisabled(), true);
    if (mobile) {
      await p.setViewportSize({ width: 844, height: 390 });
      await contained(p);
      assert.equal(await confirm(p).isDisabled(), true);
    }
    await p.waitForFunction(() => document.querySelector('.site-notice-confirm').textContent === '我已知晓');
    assert.equal(await confirm(p).isDisabled(), true, 'Finishing the countdown cannot bypass reading to the end');
    await body.focus(); await p.keyboard.press('End');
    await p.waitForFunction(() => !document.querySelector('.site-notice-confirm').disabled);
    await p.keyboard.press('Home');
    assert.equal(await confirm(p).isEnabled(), true);
    await confirm(p).click();
    await p.reload();
    await p.locator('.site-notice-entry').first().waitFor({ state: 'attached' });
    assert.equal(await modal(p).isVisible(), false);
    if (mobile) {
      await p.setViewportSize({ width: 390, height: 844 });
      const menu = p.getByRole('button', { name: '打开导航', exact: true });
      await menu.click();
      await p.locator('.site-menu .site-notice-entry').click();
      assert.equal(await p.locator('.site-menu').isVisible(), false);
      await confirm(p).click();
      await modal(p).waitFor({ state: 'hidden' });
      assert.equal(await menu.evaluate(el => el === document.activeElement), true);
      await p.goto(base + '/game/');
      await p.getByRole('button', { name: '打开导航', exact: true }).click();
      await p.locator('.site-menu .site-notice-entry').click();
      await confirm(p).click();
    }
    await p.close();
  });

  await check('fresh direct game visit and version changes require acknowledgement', async () => {
    const p = await page();
    await p.addInitScript(key => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, 'draft-1');
    }, storageKey);
    await ready(p, '/game/');
    await confirm(p).click();
    await p.route('**/src/content/site-notice.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `export const siteNotice = ${JSON.stringify({ ...siteNotice, paragraphs: ['同版本修订。'] })};` }));
    await p.reload(); await p.locator('.site-notice-entry').first().waitFor();
    assert.equal(await modal(p).isVisible(), false);
    await p.unroute('**/src/content/site-notice.ts*');
    await p.route('**/src/content/site-notice.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `export const siteNotice = ${JSON.stringify({ ...siteNotice, version: 'next' })};` }));
    await p.reload(); await modal(p).waitFor({ state: 'visible' });
    await p.close();
  });

  await check('disabled storage permits confirmation with a session fallback', async () => {
    for (const blocked of [['localStorage'], ['localStorage', 'sessionStorage']]) {
      const p = await page();
      await p.addInitScript(names => { for (const name of names) Object.defineProperty(window, name, { get() { throw new DOMException('Storage disabled', 'SecurityError'); } }); }, blocked);
      await ready(p);
      await confirm(p).click(); await modal(p).waitFor({ state: 'hidden' });
      await p.locator('.site-notice-entry:visible').first().click();
      await confirm(p).click(); await modal(p).waitFor({ state: 'hidden' });
      await p.reload(); await p.locator('.site-notice-entry').first().waitFor({ state: 'attached' });
      assert.equal(await modal(p).isVisible(), blocked.length === 2);
      await p.close();
    }
  });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2) + '\n');
  await browser.close();
}
