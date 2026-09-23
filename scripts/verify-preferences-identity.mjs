import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5297';
assert.equal(process.env.PREFERENCES_DISPOSABLE_PREVIEW, '1', 'Requires an explicitly disposable preview database');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = await verificationDirectory('preferences-identity-ui');
const browser = await chromium.launch({ headless: true });
const report = [];
async function until(check, message) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
    const legacy = viewport.width > 500 && process.env.PREFERENCES_LEGACY_FIXTURE === '1';
    if (legacy) await context.addCookies([{ name: 'atlas_preferences', value: 'synthetic-identity-preview', url: `${base}/api/preferences/` }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const get = async path => { const response = await context.request.get(`${base}/api/preferences/${path}`); assert.equal(response.status(), 200); return response.json(); };
    await page.goto(`${base}/preferences/`);
    await page.getByRole('navigation', { name: '人物喜好功能' }).getByRole('button', { name: '厨力支持', exact: true }).waitFor();
    const catalog = (await get('catalog/')).catalog;
    assert.ok(catalog.subjects.some(s => s.id === 'form:char_1012_skadi2'));
    assert.ok(!catalog.subjects.some(s => s.id === 'form:char_612_accast'));
    if (!(await get('state/')).pending_task) await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), 'Comparison art loaded');
    const pending = (await get('state/')).pending_task;
    assert.equal(await page.locator('.random-person h3').first().innerText(), pending.left.name);
    assert.equal(pending.left.id, pending.left_subject_id);
    assert.equal(pending.left.person_id, pending.left_id);
    await page.reload();
    await until(async () => await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), 'Pending task restored');
    assert.equal((await get('state/')).pending_task.id, pending.id);
    await page.screenshot({ path: path.join(output, `${viewport.width}-comparison.png`) });
    await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().click();
    await until(async () => (await get('records/')).records.some(r => r.id === pending.id), 'One raw answer saved');
    await page.getByRole('button', { name: '我的记录', exact: true }).click();
    const record = (await get('records/')).records.find(r => r.id === pending.id);
    assert.equal(record.winner_id, pending.left_id);
    assert.equal(record.left_subject_id, pending.left_subject_id);
    await until(async () => (await page.locator('.records-view').innerText()).includes(pending.left.name), 'Records show the actual form');

    await page.getByRole('navigation', { name: '人物喜好功能' }).getByRole('button', { name: '厨力支持', exact: true }).click();
    if (legacy) assert.match(await page.locator('.support-draft').innerText(), /棘刺.*旧登记/s);
    await page.getByRole('searchbox', { name: '搜索人物', exact: true }).fill('斯卡蒂');
    for (const name of ['斯卡蒂', '浊心斯卡蒂']) {
      const row = page.locator('.support-directory article').filter({ has: page.getByRole('button', { name, exact: true }) });
      const add = row.getByRole('button', { name: '加入支持', exact: true });
      if (await add.count()) await add.click();
    }
    const savedRows = page.locator('.support-draft-person');
    await savedRows.filter({ has: page.getByRole('button', { name: '斯卡蒂', exact: true }) }).getByRole('button', { name: '标为本命' }).click();
    await savedRows.filter({ has: page.getByRole('button', { name: '浊心斯卡蒂', exact: true }) }).getByRole('button', { name: '标为本命' }).click();
    assert.equal(await savedRows.getByRole('button', { name: '本命', exact: true }).count(), 1);
    await page.getByRole('button', { name: '保存整份名单', exact: true }).click();
    await until(async () => (await get('state/')).supports.subject_support_ids.length === 2, 'Form supports saved');
    const saved = (await get('state/')).supports;
    assert.deepEqual(saved.subject_favorite_ids, ['form:char_1012_skadi2']);
    assert.equal(saved.support_ids.filter(id => id === 'char_263_skadi').length, 1);
    if (legacy) assert.deepEqual(saved.legacy_support_ids, ['char_293_thorns']);
    await page.reload();
    await page.getByRole('navigation', { name: '人物喜好功能' }).getByRole('button', { name: '厨力支持', exact: true }).click();
    assert.equal(await page.locator('.support-draft-person').count(), legacy ? 3 : 2);
    await page.screenshot({ path: path.join(output, `${viewport.width}-supports.png`) });

    await page.getByRole('button', { name: '榜单与趋势', exact: true }).click();
    const scopes = page.getByRole('group', { name: '人物合并方式' });
    await scopes.getByRole('button', { name: '干员分开' }).waitFor();
    assert.equal(await scopes.getByRole('button', { name: '干员分开' }).getAttribute('aria-pressed'), 'true');
    for (const [scope, label] of [['person', '人物合并'], ['form', '干员分开']]) {
      const response = page.waitForResponse(r => r.url().includes('/rankings/') && new URL(r.url()).searchParams.get('scope') === scope);
      await scopes.getByRole('button', { name: label }).click();
      const result = await (await response).json();
      assert.equal(result.snapshot.scope, scope);
      assert.ok(result.snapshot.payload.rows.every(r => scope === 'person' ? !r.id.startsWith('form:') : r.id.startsWith('form:') || r.id.startsWith('person:')));
    }
    await page.screenshot({ path: path.join(output, `${viewport.width}-rankings.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // 读取失败时不把旧视图的数据显示成新视图；这里只模拟响应故障，不写业务数据。
    await page.route('**/api/preferences/rankings/**', async route => {
      if (new URL(route.request().url()).searchParams.get('scope') === 'person') {
        await route.fulfill({ status: 503, json: { code: 'unavailable', detail: 'Synthetic scope read failure' } });
      } else await route.continue();
    });
    await scopes.getByRole('button', { name: '人物合并' }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic scope read failure' }).waitFor();
    assert.equal(await page.locator('.preference-results .pref-table tbody tr').count(), 0);
    await page.unroute('**/api/preferences/rankings/**');
    // 已撤下的对象仍须可见、可移除，不能藏成无法保存的幽灵草稿。
    await page.route(/\/api\/preferences\/(state|identity)\//, async route => {
      const response = await route.fetch(), data = await response.json();
      data.supports.subject_support_ids.push('form:synthetic-retired');
      await route.fulfill({ response, json: data });
    });
    await page.reload();
    await page.getByRole('navigation', { name: '人物喜好功能' }).getByRole('button', { name: '厨力支持', exact: true }).click();
    const retired = page.getByRole('button', { name: '移除已撤下的登记', exact: true });
    await retired.waitFor();
    await retired.click();
    assert.equal(await retired.count(), 0);
    assert.deepEqual(errors, []);
    report.push({ viewport, legacy_preserved: legacy, form_answer_recorded: true, result_scopes_isolated: true, same_person_one_support: true, failed_scope_cleared: true, retired_support_removable: true, errors });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
