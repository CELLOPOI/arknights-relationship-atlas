import { verificationReport } from './verification-output.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from './playwright.mjs';

// 仅用于本地开发库：测试会注册临时用户，并在退出时清理这些用户的社区内容。
assert.equal(process.env.COMMUNITY_TEST_WRITES, '1', 'Set COMMUNITY_TEST_WRITES=1 for a disposable development database.');
assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must match the running development API.');
const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Only local development servers are supported.');
const mailDir = process.env.EMAIL_FILE_PATH || path.join(root, '.runtime/emails');
const reportPath = await verificationReport('community', 'community-checks.json');
const users = [0, 1].map(n => ({ username: `ui_${randomUUID().slice(0, 8)}_${n}`, email: `ui_${randomUUID()}@example.test`, password: `Atlas-${randomUUID()}!` }));
const checks = [], errors = [];
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(error.message));
const account = page.locator('#account-dialog');
const record = page.locator('#community-dialog');
const personPath = '/?faction=rhodes&person=char_003_kalts#graph';
async function check(name, action) {
  try { await action(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.message.slice(0, 2000) }); throw error; }
  finally { console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`); }
}
async function ready(route = '/') {
  if (page.url() === base + route) await page.reload({ waitUntil: 'networkidle' });
  else await page.goto(base + route, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.relationshipAtlas?.getState().nodeCount === 396);
}
async function mailLink(user, action) {
  for (const file of (await fs.readdir(mailDir)).reverse()) {
    const text = await fs.readFile(path.join(mailDir, file), 'utf8');
    if (text.includes(user.email) && text.includes(`action=${action}`)) return text.match(/https?:\/\/[^\s]+/)[0];
  }
  throw new Error('Expected development email was not written.');
}
async function register(user) {
  await page.locator('.account-entry').click();
  await account.getByRole('button', { name: '注册', exact: true }).click();
  await account.getByLabel('用户名', { exact: true }).fill(user.username);
  await account.getByLabel('邮箱', { exact: false }).fill(user.email);
  await account.locator('input[name="password"]').fill(user.password);
  await account.getByLabel('再次输入密码', { exact: true }).fill(user.password);
  await account.getByRole('button', { name: '注册并发送验证邮件' }).click();
  await account.getByText('验证邮件已发送，请验证后登录。', { exact: true }).waitFor();
  await page.goto(await mailLink(user, 'verify'), { waitUntil: 'networkidle' });
  await account.getByText('邮箱验证完成，可以登录。', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('token'), false);
}
async function login(user) {
  await account.getByLabel('用户名', { exact: true }).fill(user.username);
  await account.locator('input[name="password"]').fill(user.password);
  await account.getByRole('button', { name: '进入我的档案' }).click();
  await account.getByRole('heading', { name: '我的档案' }).waitFor();
  await account.getByRole('button', { name: '关闭我的档案' }).click();
}
async function logout() {
  if (await record.isVisible()) await record.getByRole('button', { name: '关闭档案详情' }).click();
  if (!await account.isVisible()) await page.locator('.account-entry').click();
  await account.getByRole('button', { name: '账号', exact: true }).click();
  await account.getByRole('button', { name: '退出登录' }).click();
  await account.getByRole('heading', { name: '登录档案' }).waitFor();
}
async function openPerson() {
  await ready(personPath);
  await page.locator('.person-record-button').click();
  await record.getByRole('heading', { name: '凯尔希', exact: true }).waitFor();
  await record.locator('.archive-empty').filter({ hasText: '正在读取' }).waitFor({ state: 'hidden' });
}
try {
  await ready();
  await check('registration, email verification, login and token removal', async () => { await register(users[0]); await login(users[0]); });
  await check('person favorite and public comment persist', async () => {
    await openPerson();
    await record.getByRole('button', { name: '收藏这份档案' }).click();
    await record.getByRole('button', { name: '已收藏 · 取消收藏' }).waitFor();
    await record.locator('textarea[name="comment"]').fill('浏览器验收：人物评论立即公开。');
    await record.getByRole('button', { name: '发布评论' }).click();
    await record.locator('.comment-body').filter({ hasText: '浏览器验收：人物评论立即公开。' }).waitFor();
    await openPerson();
    await record.getByRole('button', { name: '已收藏 · 取消收藏' }).waitFor();
  });
  await check('contribution remains pending and cannot change canonical data', async () => {
    await record.getByRole('button', { name: '补充资料', exact: true }).click();
    await record.locator('textarea[name="explanation"]').fill('浏览器验收：只测试提交与待审核状态，不修改正式资料。');
    await record.locator('textarea[name="evidence"]').fill('合成测试内容，无正式资料依据。');
    await record.getByRole('button', { name: '提交补充', exact: true }).click();
    await record.locator('[role="status"]').filter({ hasText: '审核' }).waitFor();
    await record.getByRole('button', { name: '关闭档案详情' }).click();
    await page.locator('.account-entry').click();
    await account.getByRole('button', { name: '我的补充', exact: true }).click();
    await account.getByText('待审核', { exact: true }).waitFor();
    assert.equal((await (await page.request.get(base + '/api/people/char_003_kalts/')).json()).name, '凯尔希');
    await account.getByRole('button', { name: '关闭我的档案' }).click();
  });
  await check('relationship evidence, favorites, comments and own deletion', async () => {
    await page.locator('#open-list').click();
    await page.locator('[data-detail]').first().click();
    await page.locator('.dossier-quote').waitFor();
    await page.locator('.record-community-button').click();
    await record.locator('.record-relation').waitFor();
    await record.getByRole('button', { name: '收藏这份档案' }).click();
    await record.getByRole('button', { name: '已收藏 · 取消收藏' }).waitFor();
    await record.getByRole('button', { name: '原文依据' }).click();
    assert.ok((await record.locator('blockquote').first().textContent()).length > 0);
    await record.getByRole('button', { name: /^讨论/ }).click();
    await record.locator('textarea[name="comment"]').fill('浏览器验收：关系评论删除流程。');
    await record.getByRole('button', { name: '发布评论' }).click();
    await record.getByText('浏览器验收：关系评论删除流程。', { exact: true }).waitFor();
    await record.getByRole('button', { name: '删除', exact: true }).click();
    await record.getByRole('button', { name: '确定删除' }).click();
    await record.getByText('浏览器验收：关系评论删除流程。', { exact: true }).waitFor({ state: 'hidden' });
    await record.getByRole('button', { name: '关闭档案详情' }).click();
    await page.locator('.account-entry').click();
    await account.getByRole('button', { name: '我的收藏', exact: true }).click();
    await account.locator('.archive-records li').nth(1).waitFor();
    assert.equal(await account.locator('.archive-records li').count(), 2);
  });
  await check('logout keeps comments public and personal collections private', async () => {
    await logout(); await openPerson();
    await record.getByText('浏览器验收：人物评论立即公开。', { exact: true }).waitFor();
    assert.equal(await record.locator('textarea[name="comment"]').count(), 0);
    assert.equal((await page.request.get(base + '/api/favorites/')).status(), 403);
    await record.getByRole('button', { name: '关闭档案详情' }).click();
  });
  await check('another account can report a public comment', async () => {
    await register(users[1]); await login(users[1]); await openPerson();
    await record.getByRole('button', { name: '举报', exact: true }).click();
    await record.getByLabel('举报原因', { exact: true }).fill('浏览器验收：合成举报流程。');
    await record.getByRole('button', { name: '提交举报' }).click();
    await record.getByText('举报已提交，管理员会核查。', { exact: true }).waitFor();
    await logout();
  });
  await check('password reset email and new-password login', async () => {
    await account.getByRole('button', { name: '忘记密码' }).click();
    await account.getByLabel('邮箱', { exact: true }).fill(users[0].email);
    await account.getByRole('button', { name: '发送邮件', exact: true }).click();
    await account.getByText('如果邮箱对应的账号符合条件，邮件将发送至该邮箱。', { exact: true }).waitFor();
    await page.goto(await mailLink(users[0], 'reset'), { waitUntil: 'networkidle' });
    users[0].password = `Changed-${randomUUID()}!`;
    await account.locator('input[name="password"]').fill(users[0].password);
    await account.getByLabel('再次输入密码', { exact: true }).fill(users[0].password);
    await account.getByRole('button', { name: '更新密码' }).click();
    await account.getByText('密码已更新，请重新登录。', { exact: true }).waitFor();
    await login(users[0]);
  });
  await check('scope selection and links preserve all-person mode', async () => {
    await ready('/#factions');
    await page.locator('#archive-scope').selectOption('all');
    await page.waitForURL('**scope=all#factions');
    await page.locator('.scope-note').waitFor();
    assert.match(await page.locator('.faction-entry').first().getAttribute('href'), /scope=all/);
    await page.locator('.faction-entry[data-enter="rhodes"]').click();
    assert.equal(new URL(page.url()).searchParams.get('scope'), 'all');
  });
  await check('mobile detail fits viewport and keyboard dismisses', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPerson();
    const bounds = await record.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 845);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.keyboard.press('Escape');
    assert.equal(await record.isVisible(), false);
  });
  assert.deepEqual(errors, []);
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
  console.error('Visible feedback:', await page.locator('.archive-feedback:visible').allTextContents());
} finally {
  await browser.close();
  const cleanup = spawnSync(path.join(root, 'backend/.venv/bin/python'), ['-c', `
import json, os, sys
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django
django.setup()
from atlas.models import User, Comment, Report, Submission
users = User.objects.filter(username__in=json.loads(sys.argv[1]))
Report.objects.filter(reporter__in=users).delete()
Submission.objects.filter(author__in=users).delete()
Comment.objects.filter(author__in=users).delete()
users.delete()
`, JSON.stringify(users.map(user => user.username))], { cwd: path.join(root, 'backend'), env: process.env, encoding: 'utf8' });
  if (cleanup.status !== 0) { errors.push(cleanup.stderr); process.exitCode = 1; }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ checks, errors, cleanup: cleanup.status === 0 }, null, 2));
}
