import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = `${root}.runtime/verification/feedback`;
await mkdir(output, { recursive: true });
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5174';
const graph = JSON.parse(await readFile(`${root}data/npc/graph.json`, 'utf8'));
const mitLicense = await readFile(`${root}LICENSE`, 'utf8');
const person = { ...graph.nodes[0], isOperator: true, avatar: `/avatars/${graph.nodes[0].id}.webp`, avatarSource: '', version: 1 };
const relation = { id: graph.edges[0].id, title: '阿米娅与凯尔希', people: [person, { ...person, ...graph.nodes[1] }], kind: 'mutual', note: '测试关系说明', evidence: [{ id: 1, quote: '测试原文，必须在关闭社区后仍可查阅。', sources: [{ source: '测试章节', line: 10 }] }] };
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'csrftoken', value: 'feedback-ui-test', url: base }]);
    let posts = [], nextStatus = 429, forbidden = [];
    // 所有 API 都在浏览器内隔离；任何漏列的请求均拒绝，绝不转发业务后端。
    await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = value => route.fulfill({ status: 200, json: value });
      if (path === '/api/session/') return json({ user: { username: 'legacy-user' }, communityEnabled: false, registrationEnabled: false, feedbackEnabled: true });
      if (path === '/api/graph/') return json(graph);
      if (path.startsWith('/api/people/')) return json(person);
      if (path.startsWith('/api/relationships/')) return json(relation);
      if (path === '/api/feedback/') {
        assert.equal(route.request().headers()['x-csrftoken'], 'feedback-ui-test');
        posts.push(route.request().postDataJSON());
        await new Promise(resolve => setTimeout(resolve, 120));
        return route.fulfill({ status: nextStatus, headers: { 'Retry-After': '60' }, json: { detail: nextStatus === 202 ? '反馈已收到，维护者会核查。' : '请求过于频繁。' } });
      }
      forbidden.push(path); return route.fulfill({ status: 403, json: { detail: 'Not available in visitor mode' } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const entry = page.getByRole('button', { name: '反馈问题', exact: true });
    await entry.waitFor();
    assert.equal(await page.locator('.source-notice-link').isVisible(), true);
    assert.equal(await page.locator('.source-notice-link').getAttribute('href'), '/sources/');
    assert.equal(await page.getByRole('button', { name: /登录|我的档案/ }).count(), 0);
    await entry.click();
    await page.getByLabel('问题说明（必填）').fill('资料中的关系方向需要核对。');
    await page.screenshot({ path: `${output}/${viewport.width}-form.png` });
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.getByRole('button', { name: '正在提交…' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '正在提交…' }).isDisabled(), true);
    await page.getByRole('alert').waitFor();
    await page.screenshot({ path: `${output}/${viewport.width}-error.png` });
    assert.match(await page.getByRole('alert').innerText(), /60 秒/);
    assert.equal(await page.getByLabel('问题说明（必填）').inputValue(), '资料中的关系方向需要核对。');
    nextStatus = 202;
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.getByText('反馈已收到，维护者会核查。', { exact: true }).waitFor();
    assert.equal(posts.length, 2);
    await page.screenshot({ path: `${output}/${viewport.width}-success.png` });
    await page.keyboard.press('Escape');
    assert.equal(await entry.evaluate(el => el === document.activeElement), true);
    // 通过图谱的公开导航与人物档案入口查阅资料。
    await page.evaluate(id => window.relationshipAtlas.navigate(id), person.id);
    await page.getByRole('button', { name: '人物档案', exact: true }).click();
    await page.getByRole('heading', { name: '称呼与别名' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /收藏|讨论|登录后/ }).count(), 0);
    await page.getByRole('button', { name: '反馈这份资料' }).click();
    assert.match(await page.locator('.feedback-target').innerText(), new RegExp(person.name));
    await page.getByRole('button', { name: '移除对象' }).click();
    assert.equal(await page.locator('.feedback-target').count(), 0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.evaluate(id => window.relationshipAtlas.showEdge(id), relation.id);
    await page.getByRole('button', { name: '查看关系档案' }).click();
    await page.getByText(relation.evidence[0].quote, { exact: true }).waitFor();
    await page.getByRole('button', { name: '反馈这份资料' }).click();
    await page.getByLabel('问题说明（必填）').fill('补充关系来源。');
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.getByText('反馈已收到，维护者会核查。', { exact: true }).waitFor();
    assert.equal(posts.at(-1).targetType, 'relationship');
    assert.equal(posts.at(-1).targetId, relation.id);
    await page.goto(`${base}/game/`);
    await page.getByRole('button', { name: '反馈问题', exact: true }).click();
    await page.getByLabel('问题说明（必填）').waitFor();
    assert.equal(await page.locator('.feedback-target').count(), 0);
    await page.screenshot({ path: `${output}/${viewport.width}-game.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: '来源与版权 · 非官方', exact: true }).click();
    await page.getByRole('heading', { name: '来源与版权', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.title(), '来源与版权 · 干员关系档案');
    assert.equal(await page.locator('canvas').count(), 0);
    await page.screenshot({ path: `${output}/${viewport.width}-sources.png` });
    await page.getByText('查看原创代码的 MIT 许可全文', { exact: true }).click();
    assert.equal(await page.locator('.sources-license pre').textContent(), mitLicense);
    for (const path of ['/assets/licenses/SourceHanSans-OFL.txt', '/assets/licenses/Oswald-OFL.txt', '/assets/licenses/frontend-dependencies.txt']) {
      const license = await context.request.get(`${base}${path}`);
      assert.equal(license.status(), 200);
      assert.match(await license.text(), /Permission is hereby granted/);
    }
    const rightsEntry = page.getByRole('button', { name: '反馈来源或版权问题', exact: true });
    await rightsEntry.click();
    assert.equal(await page.getByLabel('问题类型').inputValue(), 'source');
    await page.getByLabel('问题说明（必填）').fill('请核对这张图片的来源与权利归属。');
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.getByText('反馈已收到，维护者会核查。', { exact: true }).waitFor();
    assert.equal(posts.at(-1).type, 'source');
    assert.equal(posts.at(-1).targetId, undefined);
    await page.keyboard.press('Escape');
    assert.equal(await rightsEntry.evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: `${output}/${viewport.width}-sources-feedback.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${viewport.width}: visitor details, private feedback, retry, target, focus, game, sources and licenses`);
  }
} finally { await browser.close(); }
