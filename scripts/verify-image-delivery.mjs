import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { assetRoutes, assetVersions } from '../frontend/scripts/asset-delivery.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

// 使用真实构建、真实素材和 Caddy；API 只提供本机合成题目，不连接数据库。
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.VERIFICATION_OUTPUT || path.join(root, '.runtime/verification/image-delivery'));
await mkdir(output, { recursive: true });
const catalog = JSON.parse(await readFile(path.join(root, 'data/preferences/catalog.json')));
const manifest = JSON.parse(await readFile(path.join(root, 'assets/preferences-manifest.json')));
const files = new Map(manifest.files.map(f => ['/assets/preferences/' + f.path, f]));
const art = ['char_002_amiya_1plus.webp', 'char_1035_wisdel_1.webp'].map(name => {
  const image = catalog.appearances.find(a => a.image_url.endsWith('/' + name));
  assert.ok(image, name); return image;
});
const pair = art.map(a => {
  const form = catalog.forms.find(f => f.id === a.form_id);
  const person = catalog.persons.find(p => p.id === form.person_id);
  return { ...person, id: 'form:' + form.id, person_id: person.id, form_id: form.id, name: form.name, representative_url: a.image_url };
});
catalog.subjects = pair;
const now = '2026-09-25T00:00:00Z';
const task = { id: 'synthetic-task', left: pair[0], right: pair[1], left_id: pair[0].person_id, right_id: pair[1].person_id, catalog_version: catalog.version, status: 'pending' };
const state = { server_time: now, catalog_version: catalog.version, risk_status: 'accepted', writes_enabled: true, cooldown_hours: 24, choice_order_seed: 'synthetic-images', choices: [], pending_task: null, supports: { support_ids: [], favorite_ids: [], version: 0, support_limit: 15, favorite_limit: 3 }, quota: { remaining: 10, weekly_used: 0, weekly_limit: 120, rolling_used: 0, rolling_limit: 480, weekly_resets_at: now } };
const calls = [];
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.push(url.pathname);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json');
  const json = value => res.end(JSON.stringify(value));
  if (url.pathname === '/api/preferences/runtime/') return json({ catalog_version: catalog.version, server_time: now, config: { rest_interval: 50, cooldown_hours: 24 } });
  if (url.pathname === '/api/preferences/directory/') {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); res.setHeader('ETag', '"synthetic-directory"');
    if (req.headers['if-none-match'] === '"synthetic-directory"') { res.statusCode = 304; return res.end(); }
    return json({ catalog });
  }
  if (url.pathname === '/api/preferences/identity/' || url.pathname === '/api/preferences/state/') return json(state);
  if (url.pathname === '/api/preferences/tasks/' && req.method === 'POST') { state.pending_task = task; return json({ task }); }
  if (url.pathname === '/api/site-config/') return json({ cloudflareWebAnalyticsToken: '' });
  res.statusCode = 404; return json({ detail: 'Unlisted synthetic endpoint' });
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(fixture);
const reserve = createServer(); await listen(reserve); const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const routes = path.join(output, 'asset-routes.caddy');
await writeFile(routes, assetRoutes(await assetVersions()).replaceAll('/srv/web', path.join(root, 'frontend/build')));
const config = (await readFile(path.join(root, 'deploy/Caddyfile'), 'utf8'))
  .replace('{\n', '{\n    admin off\n').replace('api:8000', `127.0.0.1:${fixture.address().port}`)
  .replaceAll('/srv/web', path.join(root, 'frontend/build')).replace('/etc/caddy/asset-routes.caddy', routes);
const configPath = path.join(output, 'Caddyfile'); await writeFile(configPath, config);
const base = `http://127.0.0.1:${port}`;
const caddy = spawn(process.env.CADDY || 'caddy', ['run', '--config', configPath, '--adapter', 'caddyfile'], {
  env: { ...process.env, SITE_ADDRESS: base, CADDY_TRUSTED_PROXY_CIDRS: '', XDG_DATA_HOME: path.join(output, 'caddy-data'), XDG_CONFIG_HOME: path.join(output, 'caddy-config') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let log = ''; caddy.stderr.on('data', chunk => { log += chunk; });
let browser;
const report = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(base)).ok) break; } catch { /* 等待本机服务监听。 */ }
    if (attempt === 100 || caddy.exitCode !== null) throw new Error(log || 'Caddy startup timeout');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true });
  for (const device of [{ width: 390, height: 844, dpr: 2 }, { width: 390, height: 844, dpr: 3 }, { width: 1440, height: 900, dpr: 1 }]) {
    state.pending_task = null;
    const context = await browser.newContext({ viewport: device, deviceScaleFactor: device.dpr, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
    // 不使用 Playwright 路由拦截，保留浏览器真实 HTTP 缓存。
    await page.goto(base + '/preferences/');
    await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
    await page.locator('.random-person .preference-image[data-image-state="ready"]').nth(1).waitFor();
    assert.equal(await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), true);
    const images = await page.locator('.random-person img').evaluateAll(imgs => imgs.map(img => ({ src: img.currentSrc, sizes: img.sizes, fit: getComputedStyle(img).objectFit })));
    assert.ok(images.every(image => image.fit === 'contain' && image.src.includes('/media/')));
    if (device.dpr === 2) assert.ok(images.every(image => image.src.includes('/v2/thumb/')), JSON.stringify(images));
    const resources = () => page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\/media\/|\.woff2/.test(r.name)).map(r => ({ url: r.name, bytes: r.encodedBodySize, transfer: r.transferSize })));
    const cold = await resources();
    assert.ok(!cold.some(r => r.url.includes('/v2/portrait/')), 'Unopened skin directory must not request portraits');
    const downloaded = cold.filter(r => /\/v2\/(full|thumb)\//.test(r.url));
    assert.equal(downloaded.length, 2, 'Preload and displayed cards must share the selected resources');
    await page.locator('.random-pair').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `optimized-${device.width}-${device.dpr}x.png`) });
    await page.reload();
    await page.locator('.random-person .preference-image[data-image-state="ready"]').nth(1).waitFor();
    const warm = await resources();
    assert.ok(warm.length >= 2 && warm.every(r => r.transfer === 0), JSON.stringify(warm));
    await page.getByRole('button', { name: '放大' + pair[0].name + '立绘', exact: true }).click();
    await page.locator('.preference-lightbox .preference-image[data-image-state="ready"]').waitFor();
    assert.ok((await page.locator('.preference-lightbox img').getAttribute('src')).endsWith(art[0].image_url));
    assert.deepEqual(errors, []);
    report.push({ device, images, originalBytes: art.reduce((n, a) => n + files.get(a.image_url).bytes, 0), selectedBytes: downloaded.reduce((n, r) => n + r.bytes, 0), warmTransferBytes: warm.reduce((n, r) => n + r.transfer, 0) });
    await context.close();
  }
  assert.ok(calls.includes('/api/preferences/runtime/') && calls.includes('/api/preferences/directory/'));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticAPI: true, realMobileNetwork: false, report }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); caddy.kill(); fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
