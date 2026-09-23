import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { preview } = await import(require.resolve('vite'));
const server = await preview({ root: fileURLToPath(new URL('../frontend', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0, open: false } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const source = 'https://static.cloudflareinsights.com/beacon.min.js';
const token = '0123456789abcdef'.repeat(2);
const browser = await chromium.launch({ headless: true });
const errors = [];

async function scenario(name, options = {}) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sessionid', value: 'synthetic-session', url: base }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let configs = 0, beacons = 0;
  let releaseConfig;
  const pending = new Promise(resolve => { releaseConfig = resolve; });
  await page.route('https://**/*', async route => {
    if (route.request().url().startsWith(source)) {
      beacons++;
      if (options.blockBeacon) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: 'window.__testBeaconLoads = (window.__testBeaconLoads || 0) + 1;' });
    }
    // 不让验收产生真实统计、第三方请求或站点数据。
    return route.abort();
  });
  await page.route('**/api/site-config/', async route => {
    configs++;
    assert.equal(route.request().headers().cookie, undefined);
    if (options.pending) await pending;
    if (options.abort) return route.abort();
    await route.fulfill({ status: options.status || 200, contentType: 'application/json',
      body: options.body ?? JSON.stringify({ cloudflareWebAnalyticsToken: token }) }).catch(() => {});
  });
  if (options.existing) await page.route('**/sources/', async route => {
    const response = await route.fetch();
    const script = options.queryToken
      ? `<script type="module" src="${source}?token=${token}"></script>`
      : `<script type="module" src="${source}" data-cf-beacon='{"token":"${token}"}'></script>`;
    await route.fulfill({ response, body: (await response.text()).replace('</head>', `${script}</head>`) });
  });
  try {
    await page.goto(`${base}/sources/`);
    await page.locator('#sources-content').waitFor();
    assert.equal(await page.locator('#sources-content h1').innerText(), '来源与版权');
    if (options.pending) {
      // 配置未返回时正文已经可读；超时与迟到的自动脚本分别验证。
      if (options.lateBeacon) await page.evaluate(({ source, token }) => {
        const script = document.createElement('script');
        script.type = 'module'; script.src = source; script.dataset.cfBeacon = JSON.stringify({ token });
        document.head.append(script);
      }, { source, token });
      else await page.waitForTimeout(5200);
      releaseConfig();
    }
    if (options.enabled || options.existing || options.lateBeacon) {
      await page.waitForFunction(() => window.__testBeaconLoads === 1);
      const script = page.locator(`script[src^="${source}"]`);
      assert.equal(await script.count(), 1);
      assert.equal(await script.getAttribute('type'), 'module');
      if (!options.queryToken) assert.deepEqual(JSON.parse(await script.getAttribute('data-cf-beacon')), { token });
      await page.evaluate(() => { history.pushState({}, '', '/sources/?test=next'); history.back(); });
    }
    await page.waitForTimeout(150);
    assert.equal(configs, options.existing ? 0 : 1);
    assert.equal(beacons, options.enabled || options.existing || options.lateBeacon || options.blockBeacon ? 1 : 0);
    assert.equal(await page.locator('#sources-content').isVisible(), true);
    console.log(`PASS ${name}`);
  } finally {
    releaseConfig();
    await context.close();
  }
}

try {
  await scenario('runtime token loads one module beacon and survives SPA history changes', { enabled: true });
  await scenario('blank configuration keeps analytics disabled', { body: '{"cloudflareWebAnalyticsToken":""}' });
  await scenario('invalid token cannot inject a script', { body: '{"cloudflareWebAnalyticsToken":"<script>bad()</script>"}' });
  await scenario('malformed JSON does not break the page', { body: 'not-json' });
  await scenario('old or unavailable API does not break the page', { status: 404 });
  await scenario('configuration network failure does not break the page', { abort: true });
  await scenario('blocked vendor script does not break the page', { blockBeacon: true });
  await scenario('existing automatic or build beacon prevents duplicate installation', { existing: true });
  await scenario('query-token beacon prevents duplicate installation', { existing: true, queryToken: true });
  await scenario('beacon arriving during configuration lookup prevents duplicate installation', { pending: true, lateBeacon: true });
  await scenario('slow configuration times out while the page remains usable', { pending: true });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
