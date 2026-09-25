import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

// 真实目录和素材，个人状态用合成响应；所有 API 请求均拦截，不写业务库。
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5296';
const output = await verificationDirectory('skin-fixes');
const catalog = JSON.parse(await readFile(new URL('../data/preferences/catalog.json', import.meta.url), 'utf8'));
const config = { rest_interval: 50, support_limit: 15, favorite_limit: 3, cooldown_hours: 24 };
const browser = await chromium.launch({ headless: true });
const reports = [];
async function boundaryGesture(page, selector, direction, touch) {
  const root = page.locator(selector);
  await root.evaluate((node, value) => { node.scrollTop = value > 0 ? node.scrollHeight : 0; }, direction);
  await page.waitForTimeout(220);
  const box = await root.boundingBox(), x = box.x + 8, y = box.y + box.height / 2;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - direction * i * 10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else { await page.mouse.move(x, y); await page.mouse.wheel(0, direction * 120); }
  await page.waitForTimeout(250);
}
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 500 });
    await context.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
    let chosen = '';
    const forbidden = [], errors = [];
    const state = () => ({
      server_time: '2026-09-23T12:00:00Z', catalog_version: catalog.version, writes_enabled: false,
      risk_status: 'accepted', choice_order_seed: 'skin-fix-fixture', cooldown_hours: 24,
      quota: { weekly_used: 0, weekly_limit: 120, rolling_used: 0, rolling_limit: 480, remaining: 120 },
      pending_task: null, supports: { support_ids: [], favorite_ids: [], version: 0, support_limit: 15, favorite_limit: 3 },
      choices: chosen ? [{ kind: 'skin', object_id: 'char_293_thorns', choice_id: chosen, action: 'choose',
        version: 1, available: true, confirmed: true, catalog_version: catalog.forms.find(f => f.id === 'char_293_thorns').catalog_version }] : [],
    });
    await context.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, feedbackEnabled: true } });
      if (url.pathname === '/api/site-config/') return route.fulfill({ json: { cloudflareWebAnalyticsToken: '' } });
      if (url.pathname === '/api/preferences/catalog/') return route.fulfill({ json: { catalog, config } });
      if (url.pathname === '/api/preferences/runtime/') return route.fulfill({ json: { catalog_version: catalog.version, config } });
      if (url.pathname === '/api/preferences/directory/') return route.fulfill({ json: { catalog } });
      if (['/api/preferences/identity/', '/api/preferences/state/'].includes(url.pathname)) return route.fulfill({ json: state() });
      forbidden.push(url.pathname);
      return route.fulfill({ status: 500, json: { detail: 'Unexpected verification request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/preferences/?tab=skins`);
    await page.locator('.skin-card').first().waitFor();
    assert.equal(await page.locator('.skin-card').count(), 440);
    assert.match(await page.locator('.skins-view .preference-title').innerText(), /440/);
    const search = page.getByRole('searchbox', { name: '搜索干员' });
    for (const name of ['Sharp', 'Pith', 'Touch', 'Stormeye', '郁金香', '暮落']) {
      await search.fill(name);
      assert.equal(await page.locator('.skin-card-name').filter({ hasText: new RegExp(`^${name}$`) }).count(), 1, name);
    }
    await search.fill('阿米娅');
    assert.equal(await page.locator('.skin-card').count(), 3);
    await search.fill('斯卡蒂');
    assert.equal(await page.locator('.skin-card').count(), 2);

    for (const stage of ['base', 'elite']) {
      if (stage === 'elite') {
        chosen = 'char_293_thorns#2';
        await page.reload();
        await page.locator('.skin-card').first().waitFor();
      }
      await search.fill('棘刺');
      const card = page.locator('[data-form-id="char_293_thorns"]');
      await card.locator('[data-image-state="ready"]').waitFor();
      assert.equal(await card.getAttribute('data-appearance-id'), stage === 'elite' ? chosen : 'char_293_thorns#1');
      assert.match(await card.locator('img').getAttribute('src'), /thorns-alignment-v1/);
      await card.focus();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `${viewport.width}-thorns-${stage}.png`) });
      await card.click();
      assert.equal(await page.locator('.preference-detail[open] .choice-option').count(), 4);
      await page.getByRole('button', { name: '返回目录' }).click();
    }
    await boundaryGesture(page, '.preferences-workspace', 1, viewport.width < 500);
    assert.equal(new URL(page.url()).pathname, '/preferences/', 'Preferences is the final swipe page');
    await page.locator('a.preferences-source').click();
    await page.locator('#sources-content').waitFor();
    for (const direction of [-1, 1]) {
      await boundaryGesture(page, '#sources-content', direction, viewport.width < 500);
      assert.equal(new URL(page.url()).pathname, '/sources/', 'Sources never participates in swipe navigation');
    }
    await page.goto(`${base}/preferences/?tab=skins&form=char_613_acmedc`);
    await page.locator('.preference-detail[open]').waitFor();
    assert.equal(await page.locator('#skin-detail-title').innerText(), 'Touch');
    assert.equal(await page.locator('.choice-option').count(), 1);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    reports.push({ viewport, directory: 440, deduplicated_names: 6, retained_alters: true, legacy_detail: true, sources_excluded_from_swipes: true, errors });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'skin-fixes-report.json'), JSON.stringify(reports, null, 2) + '\n');
console.log(JSON.stringify(reports));
