import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { chromium } from './playwright.mjs';
const root = path.resolve(import.meta.dirname, '..');
const output = await verificationDirectory('npc');
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const graph = JSON.parse(await fs.readFile(path.join(root, 'data/npc/graph.json')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'assets/npc-manifest.json')));
const oldGraph = JSON.parse(await fs.readFile(path.join(root, 'dist/data/graph.json')));
const byName = name => graph.nodes.find(n => n.name === name).id;
const operators = new Set(graph.nodes.filter(n => n.isOperator !== false).map(n => n.id));
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const checks = [], errors = [], failures = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, error: e.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function page(viewport) {
  const p = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  p.setDefaultTimeout(12000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('response', r => { if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() }); });
  return p;
}
async function ready(p, route) {
  await p.goto(base + route, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.relationshipAtlas && window.terraPortal);
  await p.evaluate(() => document.fonts.ready);
}
const desktop = await page({ width: 1440, height: 900 });
await check('API scopes match the import bundle and preserve original relations', async () => {
  const all = await (await desktop.request.get(base + '/api/graph/?scope=all')).json();
  const filtered = await (await desktop.request.get(base + '/api/graph/')).json();
  assert.equal(all.nodes.length, graph.nodes.length);
  assert.equal(all.edges.length, graph.edges.length);
  assert.equal(filtered.nodes.length, operators.size);
  assert.equal(filtered.edges.length, graph.edges.filter(e => operators.has(e.source) && operators.has(e.target)).length);
  assert.equal(all.npcCount, 169);
  for (const old of oldGraph.edges) {
    const current = all.edges.find(e => e.id === old.id);
    for (const key of ['source', 'target', 'kind', 'from', 'to']) assert.equal(current[key], old[key]);
  }
});
await check('every NPC avatar is local and loads', async () => {
  for (let i = 0; i < manifest.assets.length; i += 8) {
    await Promise.all(manifest.assets.slice(i, i + 8).map(async a => {
      const r = await desktop.request.get(base + '/avatars/' + a.filename);
      assert.equal(r.status(), 200, a.name);
      assert.match(r.headers()['content-type'], /image\/webp/);
    }));
  }
});
await check('NPC direct link, aliases, and refresh work', async () => {
  await ready(desktop, `/?scope=all&person=${byName('博士')}#graph`);
  assert.equal(await desktop.evaluate(() => window.relationshipAtlas.getState().focus), byName('博士'));
  await desktop.locator('#search').fill('叶莲娜');
  await desktop.locator('#search').press('Enter');
  assert.equal(await desktop.evaluate(() => window.relationshipAtlas.getState().focus), byName('霜星'));
  await desktop.reload({ waitUntil: 'networkidle' });
  assert.equal(await desktop.evaluate(() => window.relationshipAtlas.getState().focus), byName('霜星'));
  await desktop.screenshot({ path: path.join(output, 'desktop.png') });
});
await check('human direction and story text are visible in relationship details', async () => {
  const key = ['char_4146_nymph', byName('孽茨雷')].sort().join('|');
  await desktop.evaluate(id => window.relationshipAtlas.showEdge(id), key);
  await desktop.locator('.dossier-quote').waitFor();
  const quote = await desktop.locator('.dossier-quote').innerText();
  assert.ok(quote.includes('妮芙：') && !quote.includes('[charslot'));
  assert.ok((await desktop.locator('#evidence-body').innerText()).includes('人工复核'));
  await desktop.screenshot({ path: path.join(output, 'desktop-evidence.png') });
  await desktop.evaluate(() => window.relationshipAtlas.closePanel());
});
await check('generic portrait provenance appears in person details', async () => {
  await ready(desktop, `/?scope=all&person=${byName('Medic')}#graph`);
  await desktop.getByRole('button', { name: '人物档案', exact: true }).click();
  await desktop.getByRole('button', { name: '人物资料', exact: true }).click();
  await desktop.getByText('此为通用立绘，仅代表角色的大致形象。').waitFor();
  assert.match(await desktop.getByRole('link', { name: '查看 PRTS 原图' }).getAttribute('href'), /^https:\/\/prts\.wiki\//);
  await desktop.screenshot({ path: path.join(output, 'desktop-person.png') });
  await desktop.getByRole('button', { name: '关闭档案详情' }).click();
});
await check('switching to operators excludes NPC search and keeps the page usable', async () => {
  await ready(desktop, '/?scope=all#factions');
  await desktop.locator('#archive-scope').selectOption('operators');
  await desktop.waitForLoadState('networkidle');
  await desktop.waitForFunction(() => window.relationshipAtlas?.getState().nodeCount === 396);
  await desktop.locator('.faction-entry[data-enter="rhodes"]').click();
  await desktop.locator('#search').fill('霜星');
  assert.equal(await desktop.locator('[data-search-id]').count(), 0);
});
await check('new NPC faction is reachable from the full directory', async () => {
  await ready(desktop, '/?scope=all#factions');
  await desktop.locator('.faction-entry[data-enter="reunion"]').click();
  assert.equal(await desktop.evaluate(() => window.relationshipAtlas.getState().scopeFaction), 'reunion');
  assert.ok((await desktop.evaluate(() => window.relationshipAtlas.getState().visiblePeople)).includes(byName('塔露拉')));
});
const mobile = await page({ width: 390, height: 844 });
await check('mobile NPC graph, details and scope switching fit the viewport', async () => {
  await ready(mobile, `/?scope=all&person=${byName('塔露拉')}#graph`);
  assert.equal(await mobile.evaluate(() => window.relationshipAtlas.getState().focus), byName('塔露拉'));
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.screenshot({ path: path.join(output, 'mobile.png') });
  await mobile.getByRole('button', { name: '人物档案', exact: true }).click();
  await mobile.getByRole('button', { name: '人物资料', exact: true }).click();
  await mobile.getByRole('link', { name: '查看 PRTS 原图' }).waitFor();
  await mobile.screenshot({ path: path.join(output, 'mobile-person.png') });
  await mobile.getByRole('button', { name: '关闭档案详情' }).click();
  assert.ok(await mobile.locator('#search').isVisible());
});
await browser.close();
const report = { checks, errors, failures, pass: checks.every(c => c.pass) && !errors.length && !failures.length };
await fs.writeFile(path.join(output, 'ui-checks.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
