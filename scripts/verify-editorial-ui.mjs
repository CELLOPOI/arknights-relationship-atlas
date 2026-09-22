import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:8153';
assert.equal(process.env.ATLAS_EDITORIAL_TEST_WRITES, '1', 'Explicitly enable writes to the disposable test database.');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Browser write checks require a loopback URL.');
const credentials = JSON.parse(await readFile(process.env.EDITORIAL_TEST_AUTH, 'utf8'));
const output = await verificationDirectory('editorial');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const report = { base, checks: [], screenshots: [] };
const unique = Date.now().toString(36);
const personId = 'npc_browser_' + unique;
const relationshipId = 'rel_browser_' + unique;
let batchUrl;

async function click(name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForLoadState('domcontentloaded');
  const errors = await page.locator('.errornote, .errorlist').allTextContents();
  assert.deepEqual(errors.filter(text => text.trim()), [], 'Form validation failed: ' + errors.join(' '));
}

async function capture(name) {
  for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, name + '-' + device + '.png'), fullPage: true });
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(dimensions.scroll <= dimensions.client + 1, JSON.stringify(dimensions));
    report.screenshots.push(name + '-' + device + '.png');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function addRecord(section, newId) {
  await page.goto(batchUrl.replace('/change/', '/record/') + '?section=' + section);
  await page.getByLabel('新增稳定 ID:', { exact: true }).fill(newId);
  await click('添加并编辑');
}

async function saveAndReturn() {
  await click('保存候选');
  await page.getByRole('link', { name: /^返回修订：/ }).click();
  await page.waitForLoadState('domcontentloaded');
}

async function approveAndPublish(name) {
  await click('提交审核');
  await page.getByLabel('审核或退回理由').fill('本地验证：已核对测试原文、方向和来源。');
  await click('审核通过');
  await click('预览发布');
  await capture(name + '-preview');
  await click('确认发布此版本');
}

try {
  await page.goto(base + '/admin/login/');
  await page.getByLabel('用户名:').fill(credentials.username);
  await page.getByLabel('密码:').fill(credentials.password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(base + '/admin/');
  await page.goto(base + '/admin/atlas/feedback/' + credentials.feedback + '/change/');
  await page.getByRole('link', { name: '根据此反馈创建资料修订' }).click();
  await page.getByLabel('修订标题:').fill('浏览器验证：新增人物及有方向的关系');
  await page.getByLabel('修改说明与依据:').fill('隔离测试资料；验证人物、关系和原文能够一并审核发布。');
  await click('创建草稿');
  batchUrl = page.url();
  await addRecord('people', personId);
  await page.getByLabel('姓名:').fill('本地验证人物');
  await page.getByLabel('当前阵营:').selectOption('rhodes');
  await capture('person-editor');
  await saveAndReturn();
  await addRecord('relationships', relationshipId);
  await page.getByLabel('人物 A:').selectOption('char_a');
  await page.getByLabel('人物 B:').selectOption(personId);
  await page.getByLabel('判定:', { exact: true }).selectOption('awareness');
  await page.getByLabel('知晓方:').selectOption(personId);
  await page.getByLabel('判定说明:').fill('本地验证：新人物单向知晓甲。');
  await saveAndReturn();
  await addRecord('evidence', 'evidence_browser_' + unique);
  await page.getByLabel('关系:', { exact: true }).selectOption(relationshipId);
  await page.getByLabel('关键原文:').fill('本地测试原文。\n第二行用于验证换行保存。');
  await page.locator('#id_sources-0-kind').selectOption('story');
  await page.locator('#id_sources-0-source').fill('test/story.txt');
  await page.locator('#id_sources-0-line').fill('10');
  await page.locator('#id_sources-0-endLine').fill('12');
  await page.locator('#id_sources-0-version').fill('browser-fixture-v1');
  await capture('evidence-editor');
  await saveAndReturn();
  await capture('draft-diff');
  let graph = await (await context.request.get(base + '/api/graph/?scope=all')).json();
  assert.ok(!graph.nodes.some(row => row.id === personId));
  report.checks.push('Drafts remain private; linked record forms and source fields work.');
  await approveAndPublish('publication');
  graph = await (await context.request.get(base + '/api/graph/?scope=all')).json();
  assert.ok(graph.nodes.some(row => row.id === personId));
  assert.equal(graph.edges.find(row => row.id === relationshipId).from, personId);
  assert.equal(graph.dataRelease.origin, 'editorial');
  report.release = graph.dataRelease.id;
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '导出此版本资料快照' }).click(),
  ]);
  await download.saveAs(path.join(output, 'published-snapshot.zip'));
  await page.goto(base + '/admin/atlas/feedback/' + credentials.feedback + '/change/');
  assert.equal(await page.locator('#id_status').inputValue(), 'resolved');
  report.checks.push('Review, signed preview, publication, public graph, snapshot download and feedback closure work.');
  await page.goto(base + '/admin/atlas/datarelease/test-1/change/');
  await page.getByRole('link', { name: '创建回退到此版本的修订' }).click();
  await page.getByLabel('修改说明与依据:').fill('隔离测试：回退新增资料，保留账号和访客反馈。');
  await click('创建草稿');
  await approveAndPublish('rollback');
  graph = await (await context.request.get(base + '/api/graph/?scope=all')).json();
  assert.ok(!graph.nodes.some(row => row.id === personId));
  assert.ok(!graph.edges.some(row => row.id === relationshipId));
  assert.equal(graph.dataRelease.origin, 'rollback');
  report.rollback = graph.dataRelease.id;
  await page.goto(base + '/admin/atlas/feedback/' + credentials.feedback + '/change/');
  assert.equal(await page.locator('#id_status').inputValue(), 'resolved');
  report.checks.push('Rollback creates a new version and preserves feedback and the active account.');
  assert.deepEqual(errors, []);
  report.consoleErrors = errors;
  report.passed = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), checks: report.checks }));
} finally {
  await browser.close();
}
