import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from './playwright.mjs';
import { gameGraph } from './game-ui-fixture.mjs';
import { verificationDirectory } from './verification-output.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:5187';
const output = await verificationDirectory('source-titles');
const catalog = JSON.parse(await fs.readFile(new URL('../backend/atlas/data/source-titles.json', import.meta.url)));
const source = { kind: 'story', source: 'ArknightsGameData/zh_CN/gamedata/story/activities/act23side/level_act23side_07_end.txt', line: 251, endLine: 259, version: catalog.sourceCommit,
  title: catalog.entries['story:activities/act23side/level_act23side_07_end'].title };
const extra = { kind: 'profile', source: 'char_4134_cetsyr/voice/char_4134_cetsyr_EX_CN_101',
  ...catalog.entries['profile:char_4134_cetsyr/voice/char_4134_cetsyr_EX_CN_101'] };
const edge = gameGraph.edges[0];
const people = new Map(gameGraph.nodes.map(person => [person.id, person]));
const sources = [source, extra];
const makeRelation = item => ({ ...item, title: [people.get(item.source).name, people.get(item.target).name].join('与'), people: [people.get(item.source), people.get(item.target)], note: '', quote: '来源显示验收：原文与来源定位分别保留。', sources,
  evidence: [{ id: 1, quote: '来源显示验收：原文与来源定位分别保留。', sources }] });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const checks = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), 'GET', 'Source verification must never write to the API');
      if (url.pathname === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, feedbackEnabled: true } });
      if (url.pathname === '/api/graph/') return route.fulfill({ json: gameGraph });
      if (url.pathname.startsWith('/api/relationships/')) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        return route.fulfill({ json: makeRelation(gameGraph.edges.find(item => item.id === id) || edge) });
      }
      return route.fulfill({ status: 404, json: { detail: 'Unmocked API request' } });
    });
    async function verify(panel, name) {
      await panel.locator('.evidence-source-title').first().waitFor();
      assert.equal(await panel.locator('.evidence-source-title').first().innerText(), source.title);
      assert.equal(await panel.locator('.evidence-source-title').nth(1).innerText(), extra.title);
      const record = panel.locator('.evidence-source-record').first();
      assert.equal(await record.getAttribute('open'), null);
      await record.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.notEqual(await record.getAttribute('open'), null);
      assert.ok((await record.innerText()).includes(source.source));
      assert.ok((await record.innerText()).includes('第 251–259 行'));
      assert.ok((await record.innerText()).includes(source.version));
      const link = panel.locator('.evidence-source-link').first();
      assert.equal(await link.getAttribute('href'), extra.referenceUrl);
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      await record.scrollIntoViewIfNeeded();
      assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await page.screenshot({ path: `${output}/${viewport.width}-${name}.png` });
      checks.push(`${viewport.width}: ${name}, title, original locator, keyboard disclosure, link and wrapping`);
    }
    await page.goto(`${base}/?scope=all#factions`);
    await page.waitForFunction(() => window.relationshipAtlas?.showEdge);
    await page.evaluate(id => window.relationshipAtlas.showEdge(id), edge.id);
    await verify(page.locator('#evidence-body'), 'graph');
    await page.getByRole('button', { name: '查看关系档案' }).click();
    await verify(page.locator('.record-evidence'), 'record');
    await page.keyboard.press('Escape');
    await page.goto(`${base}/game/`);
    await page.locator('.game-play').waitFor();
    await page.locator('[data-mode="explore"]').click();
    await page.getByRole('button', { name: /提示下一人/ }).click();
    await page.locator('[data-hinted="true"]').click();
    await page.locator('.game-trail-edge').first().click();
    await verify(page.locator('.game-evidence'), 'game');
    assert.deepEqual(errors, []);
    await context.close();
  }
  await fs.writeFile(`${output}/report.json`, JSON.stringify({ checks }, null, 2) + '\n');
  console.log(JSON.stringify({ checks, output }, null, 2));
} finally {
  await browser.close();
}
