import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

// 所有身份、题目与票据均为浏览器内的合成数据；未列明的 API 请求一律拒绝。
// 本脚本验证交互状态，不代表真实数据库、统计有效性或真实素材视觉验收。
const base = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://127.0.0.1:5174';
const output = await verificationDirectory('preferences-ui');
const now = '2026-09-23T12:00:00+00:00';
const professions = [['PIONEER', '先锋'], ['WARRIOR', '近卫'], ['TANK', '重装'], ['SNIPER', '狙击'], ['CASTER', '术师'], ['MEDIC', '医疗'], ['SUPPORT', '辅助'], ['SPECIAL', '特种']].map(([id, name]) => ({ id, name, icon_url: `/__preferences_fixture__/${id}.svg` }));
const persons = professions.map((p, i) => ({ id: `synthetic-person-${i}`, name: `合成${p.name}人物`, aliases: [`fixture-${i}`], kind: 'operator', eligible: true, representative_url: `/__preferences_fixture__/person-${i}.svg`, form_ids: [`synthetic-form-${i}`] }));
const forms = professions.map((p, i) => ({ id: `synthetic-form-${i}`, person_id: persons[i].id, name: persons[i].name, profession: p.id, order: i, default_appearance_id: `synthetic-art-${i}-0`, catalog_version: 'synthetic-form-v1', eligible: true, complete: true, appearance_ids: [0, 1, 2].map(n => `synthetic-art-${i}-${n}`) }));
// 同职业至少两张卡，才能检验窄屏仍保留两列，而非只检验单卡没有溢出。
forms.push({ ...forms[0], id: 'synthetic-form-8', name: '合成先锋第二形态', order: 8, default_appearance_id: 'synthetic-art-8-0', appearance_ids: [0, 1, 2].map(n => `synthetic-art-8-${n}`) });
persons[0].form_ids.push('synthetic-form-8');
const appearances = forms.flatMap((f, i) => ['基础立绘', '精英二', '合成服饰'].map((name, n) => ({ id: `synthetic-art-${i}-${n}`, form_id: f.id, name, kind: ['base', 'elite', 'outfit'][n], image_url: `/__preferences_fixture__/full-${i}-${n}.svg`, thumbnail_url: `/__preferences_fixture__/thumb-${i}-${n}.svg`, eligible: true })));
const catalog = { version: 'synthetic-ui-v1', asset_version: 'synthetic-ui-assets-v1', source_version: 'synthetic-only', persons, forms, appearances, professions };
const config = { rest_interval: 50, pair_repeat_days: 84, weekly_limit: 120, rolling_limit: 480, person_limit: 3, support_limit: 15, favorite_limit: 3, cooldown_hours: 24, task_hours: 24, phase: 'trial', writes_enabled: true, tasks_enabled: true, supports_enabled: true, choices_enabled: true };
const initial = () => ({ server_time: now, catalog_version: catalog.version, risk_status: 'accepted', writes_enabled: true, task_enabled: true, cooldown_hours: 24, choice_order_seed: 'synthetic-ui-seed', quota: { weekly_limit: 120, weekly_used: 0, rolling_limit: 480, rolling_used: 0, remaining: 120, person_limit: 3, rolling_days: 28, weekly_resets_at: '2026-09-28T00:00:00+08:00', rolling_recovers_at: null }, pending_task: null, supports: { support_ids: [], favorite_ids: [], version: 0, modified_at: null, next_change_at: null, risk_status: 'accepted', support_limit: 15, favorite_limit: 3 }, choices: [] });
const clone = x => JSON.parse(JSON.stringify(x));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check, message) { const deadline = Date.now() + 10000; while (!(await check())) { if (Date.now() > deadline) assert.fail(message); await new Promise(r => setTimeout(r, 25)); } }

async function installMock(context) {
  await context.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
  const model = { catalog: clone(catalog), config: clone(config), state: initial(), calls: [], forbidden: [], choices: [], records: [], choiceStatus: 200, choiceGate: null, answerGate: null, taskGate: null, taskStatus: 200, taskPair: persons.slice(0, 2), imageGate: null, delayedImage: '', imageRequests: [], blockedImage: '', imageFailures: 0, emptySnapshot: false, identityStatus: 200, loseAnswerOnce: false, answerResponses: new Map() };
  await context.addCookies([{ name: 'csrftoken', value: 'synthetic-preferences-csrf', url: base }]);
  await context.route('**/__preferences_fixture__/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    model.imageRequests.push(pathname);
    if (model.imageGate && pathname === model.delayedImage) await model.imageGate.promise;
    if (model.blockedImage && pathname === model.blockedImage) { model.imageFailures++; return route.fulfill({ status: 503, body: 'Synthetic image failure' }); }
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720"><rect width="480" height="720" fill="#24313b"/><circle cx="240" cy="175" r="90" fill="#86ddd6"/><path d="M90 650V370Q240 245 390 370V650" fill="#507d89"/><text x="240" y="690" fill="white" text-anchor="middle" font-size="24">SYNTHETIC UI FIXTURE</text></svg>' });
  });
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
    const payload = req.postData() ? req.postDataJSON() : null;
    model.calls.push({ method: req.method(), path: pathname, payload });
    const json = (value, status = 200) => route.fulfill({ status, json: clone(value), headers: { 'Cache-Control': 'private, no-store' } });
    if (req.method() !== 'GET') assert.equal(req.headers()['x-csrftoken'], 'synthetic-preferences-csrf');
    if (pathname === '/api/session/') return json({ user: null, communityEnabled: false, feedbackEnabled: true });
    if (pathname === '/api/preferences/catalog/') return json({ catalog: model.catalog, config: model.config, server_time: now });
    if (pathname === '/api/preferences/identity/') return model.identityStatus === 200 ? json(model.state) : json({ code: 'writes_paused', detail: '合成测试：参与登记暂时暂停。' }, model.identityStatus);
    if (pathname === '/api/preferences/state/') return model.identityStatus === 200 ? json(model.state) : json({ code: 'identity_required', detail: '合成测试：尚无参与身份。' }, 401);
    if (pathname === '/api/preferences/tasks/' && req.method() === 'POST') {
      if (model.taskGate) await model.taskGate.promise;
      if (model.taskStatus !== 200) return json({ code: 'synthetic_task_failure', detail: '合成测试：下一题暂时不可用。' }, model.taskStatus);
      if (!model.state.pending_task) {
        model.state.quota.weekly_used++; model.state.quota.rolling_used++; model.state.quota.remaining--;
        const [left, right] = model.taskPair;
        model.state.pending_task = { id: `synthetic-task-${model.state.quota.weekly_used}`, left_id: left.id, right_id: right.id, left, right, catalog_version: catalog.version, issued_at: now, expires_at: '2026-09-24T12:00:00+00:00', status: 'pending', outcome: null, winner_id: null, risk_status: 'accepted' };
      }
      return json({ task: model.state.pending_task, quota: model.state.quota });
    }
    if (/^\/api\/preferences\/tasks\/[^/]+\/answer\/$/.test(pathname) && req.method() === 'POST') {
      if (model.answerGate) await model.answerGate.promise;
      const operationId = `${pathname}:${payload.operation_key}`;
      if (model.answerResponses.has(operationId)) return json(model.answerResponses.get(operationId));
      assert.equal(pathname, `/api/preferences/tasks/${model.state.pending_task?.id}/answer/`, 'Answer must target the displayed pending task');
      const task = { ...model.state.pending_task, ...payload, status: 'answered', accepted_at: now };
      model.records.push(task); model.state.pending_task = null;
      const response = clone({ task, quota: model.state.quota }); model.answerResponses.set(operationId, response);
      if (model.loseAnswerOnce) { model.loseAnswerOnce = false; return route.abort('connectionreset'); }
      return json(response);
    }
    const choice = pathname.match(/^\/api\/preferences\/choices\/(skin|form)\/([^/]+)\/(confirm\/)?$/);
    if (choice) {
      const [, kind, objectId, confirm] = choice;
      const existing = model.state.choices.find(x => x.kind === kind && x.object_id === objectId);
      if (req.method() === 'GET') return json(existing || { version: 0, action: 'withdraw', choice_id: null, catalog_version: null, confirmed: false, next_change_at: null });
      model.choices.push({ path: pathname, payload: clone(payload) });
      if (model.choiceGate) await model.choiceGate.promise;
      const currentVersion = kind === 'skin' ? model.catalog.forms.find(x => x.id === objectId)?.catalog_version : model.catalog.persons.find(x => x.id === objectId)?.form_catalog_version || model.catalog.version;
      if (payload.catalog_version !== currentVersion) return json({ code: 'catalog_conflict', detail: '合成测试：候选名录已更新，请重新核对。', catalog_version: currentVersion }, 409);
      if (model.choiceStatus !== 200) return json({ code: 'synthetic_failure', detail: '合成测试：保存失败，原选择保留。' }, model.choiceStatus);
      const saved = { ...existing, kind, object_id: objectId, version: (existing?.version || 0) + 1, action: confirm ? existing.action : payload.action, choice_id: confirm ? existing.choice_id : payload.choice_id || null, catalog_version: payload.catalog_version, confirmed: true, available: true, modified_at: confirm ? existing.modified_at : now, next_change_at: null, risk_status: 'accepted' };
      model.state.choices = [...model.state.choices.filter(x => x.kind !== kind || x.object_id !== objectId), saved];
      return json(saved);
    }
    if (pathname === '/api/preferences/supports/') {
      if (req.method() === 'PUT') model.state.supports = { ...model.state.supports, ...payload, version: model.state.supports.version + 1 };
      return json(model.state.supports);
    }
    if (pathname === '/api/preferences/records/') return json({ records: model.records, next_cursor: null });
    if (pathname === '/api/preferences/rankings/') return json({ kind: url.searchParams.get('kind'), window: Number(url.searchParams.get('window')), object_id: url.searchParams.get('object_id') || '', snapshot: model.emptySnapshot ? { id: 1, cutoff: now, generated_at: now, catalog_version: model.catalog.version, algorithm_version: 'synthetic-empty-bt', asset_version: model.catalog.asset_version, revision: 1, reason: 'Synthetic empty-sample regression', payload: { rows: persons.map(p => ({ id: p.id, score: null, interval: [null, null], rank: null, comparisons: 0, participants: 0, opponents: 0, status: 'insufficient' })), sample_size: 0, participant_count: 0, window_start: '2026-07-01T12:00:00+00:00', window_end: now, actual_days: 0, status: 'accumulating' } } : null, status: model.emptySnapshot ? 'current' : 'no_data' });
    if (pathname === '/api/preferences/trends/') return json({ snapshots: [], changes: { 7: null, 28: null } });
    if (pathname === '/api/preferences/pairs/') return json({ left_wins: 0, right_wins: 0, sample_size: 0, status: 'no_data' });
    model.forbidden.push(`${req.method()} ${pathname}`);
    return json({ code: 'synthetic_unlisted', detail: 'API blocked by isolated UI fixture' }, 403);
  });
  return model;
}
const taskCalls = model => model.calls.filter(x => x.path === '/api/preferences/tasks/').length;
const voteCalls = model => model.calls.filter(x => x.path.includes('/answer/') || x.path.includes('/choices/') && x.method !== 'GET' || x.path === '/api/preferences/supports/' && x.method === 'PUT').length;
const skinDialog = page => page.getByRole('dialog', { name: persons[0].name, exact: true });
const card = page => page.locator(`[data-form-id="${forms[0].id}"]`);
const option = (page, name) => skinDialog(page).locator('.choice-option').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function selectSkin(page, name) { const button = option(page, name).getByRole('button', { name: '选为最爱', exact: true }); await button.focus(); await page.keyboard.press('Enter'); }
async function openFirst(page) { await card(page).click(); await skinDialog(page).waitFor(); await until(async () => await skinDialog(page).locator('.choice-option .preference-image[data-image-state="ready"]').count() === 3, 'All three synthetic candidates must load'); }
async function switchTab(page, name) { await page.getByRole('navigation', { name: '喜好视图' }).getByRole('button', { name, exact: true }).click(); }
async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(x => ({ left: x.getBoundingClientRect().left, right: x.getBoundingClientRect().right, width: x.clientWidth, scroll: x.scrollWidth })) }));
  assert.ok(dimensions.document <= dimensions.width + 1 && dimensions.body <= dimensions.width + 1, `${label}: page overflow ${JSON.stringify(dimensions)}`);
  for (const dialog of dimensions.dialogs) assert.ok(dialog.left >= -1 && dialog.right <= dimensions.width + 1 && dialog.scroll <= dialog.width + 1, `${label}: dialog overflow ${JSON.stringify(dialog)}`);
}
const report = { synthetic: true, database_verified: false, base, viewports: [], regressions: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ headless: true });
async function regression(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...options });
  const model = await installMock(context), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page, model);
    assert.deepEqual(model.forbidden, []); assert.deepEqual(errors, []);
    report.regressions.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    report.regressions.push({ name, passed: false, error: error.message });
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { model.choiceGate?.resolve(); model.answerGate?.resolve(); model.taskGate?.resolve(); model.imageGate?.resolve(); await context.close(); }
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await regression(`skin-touch-swipe-${viewport.width}`, async (page, model) => {
      await page.goto(`${base}/preferences/?tab=skins`);
      const first = card(page), second = page.locator('[data-form-id="synthetic-form-8"]');
      await first.waitFor();
      await page.waitForFunction(() => !document.documentElement.dataset.sectionTransitioning);
      const filter = item => item.locator('img').evaluate(img => getComputedStyle(img).filter);
      assert.match(await filter(first), /grayscale\(1\)/);
      const a = await first.boundingBox(), b = await second.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
      const x = a.x + a.width / 2, y = a.y + a.height / 2;
      await touch('touchStart', x, y);
      for (let step = 1; step <= 10; step++) {
        await touch('touchMove', x + (b.x + b.width / 2 - x) * step / 10, y);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd');
      await until(async () => /grayscale\(0\)/.test(await filter(first)) && /grayscale\(0\)/.test(await filter(second)), 'Swiping lights both the initial card and the card under the moving finger');
      assert.equal(await page.locator('.preference-detail[open]').count(), 0, 'Swiping does not open a detail');
      await page.screenshot({ path: path.join(output, `skin-touch-swipe-${viewport.width}.png`) });
      await until(async () => /grayscale\(1\)/.test(await filter(first)) && /grayscale\(1\)/.test(await filter(second)), 'Cards return to gray after the touch trail fades');

      const workspace = page.locator('.preferences-workspace');
      const beforeScroll = await workspace.evaluate(el => el.scrollTop);
      await touch('touchStart', x, y);
      for (let step = 1; step <= 10; step++) {
        await touch('touchMove', x, y - 180 * step / 10);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd');
      await until(async () => await workspace.evaluate(el => el.scrollTop) > beforeScroll + 40, 'Swiping over cards preserves native vertical scrolling');
      assert.equal(await page.locator('.preference-detail[open]').count(), 0);
      assert.equal(voteCalls(model), 0); assert.equal(taskCalls(model), 0);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await first.scrollIntoViewIfNeeded();
      const reducedBox = await first.boundingBox();
      await touch('touchStart', reducedBox.x + reducedBox.width / 2, reducedBox.y + reducedBox.height / 2);
      await until(async () => /grayscale\(0\)/.test(await filter(first)), 'Reduced motion keeps touch color feedback');
      assert.equal(await first.locator('img').evaluate(img => getComputedStyle(img).transform), 'none');
      await touch('touchCancel');
      assert.equal(await page.locator('.skin-card.is-revealing').count(), 0, 'Canceled touches clear transient highlights');
      await first.tap(); await skinDialog(page).waitFor();
      assert.equal(voteCalls(model), 0, 'A single tap still opens the detail without voting');
      assert.equal(await page.locator('.skin-card.is-revealing').count(), 0, 'Opening detail clears touch highlights');
      await cdp.detach();
    }, { viewport, hasTouch: true, isMobile: true, reducedMotion: 'no-preference' });
  }
  await regression('skin-desktop-color-feedback', async page => {
    await page.goto(`${base}/preferences/?tab=skins`);
    const first = card(page);
    await first.waitFor();
    await page.mouse.move(1, 1);
    assert.match(await first.locator('img').evaluate(img => getComputedStyle(img).filter), /grayscale\(1\)/);
    await first.hover();
    await until(async () => /grayscale\(0\)/.test(await first.locator('img').evaluate(img => getComputedStyle(img).filter)), 'Desktop hover still lights the card');
    await page.mouse.move(1, 1); await page.keyboard.press('Tab'); await first.focus();
    assert.equal(await first.evaluate(el => el.matches(':focus-visible')), true);
    await page.keyboard.press('Enter'); await skinDialog(page).waitFor();
  }, { reducedMotion: 'no-preference' });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const model = await installMock(context), page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${base}/preferences/?tab=skins`);
      await card(page).waitFor();
      assert.equal(await page.locator('.skin-card').count(), 9);
      assert.equal(await card(page).getAttribute('data-appearance-id'), forms[0].default_appearance_id);
      assert.equal(voteCalls(model), 0, 'Opening the directory does not vote');
      assert.equal(taskCalls(model), 0, 'Opening skins does not dispatch random tasks');
      await noOverflow(page, 'directory');
      if (viewport.width <= 390) {
        const first = await card(page).boundingBox(), second = await page.locator('[data-form-id="synthetic-form-8"]').boundingBox();
        assert.ok(first && second && Math.abs(first.y - second.y) < 2 && second.x > first.x, 'Narrow screen keeps two cards in the same profession row');
      }
      for (const profession of professions) {
        await page.getByRole('button', { name: /^职业/ }).click();
        const filter = page.getByRole('dialog', { name: '选择职业' });
        await filter.waitFor(); await noOverflow(page, `filter-${profession.id}`);
        await filter.getByRole('button', { name: profession.name, exact: true }).click();
        const expectedForms = forms.filter(f => f.profession === profession.id).map(f => f.id);
        assert.deepEqual(await page.locator('.skin-card').evaluateAll(cards => cards.map(x => x.dataset.formId)), expectedForms);
        assert.equal(await page.getByRole('button', { name: /^职业/ }).evaluate(el => el === document.activeElement), true, 'Closing profession filter restores trigger focus');
      }
      await page.getByRole('button', { name: /^职业/ }).click();
      await page.getByRole('dialog', { name: '选择职业' }).getByRole('button', { name: '全部', exact: true }).click();
      await page.getByLabel('搜索干员').fill('fixture-0');
      await switchTab(page, '人物'); await switchTab(page, '皮肤');
      assert.equal(await page.getByLabel('搜索干员').inputValue(), 'fixture-0', 'Skin search survives view switching');
      await page.getByLabel('搜索干员').fill('');
      await switchTab(page, '人物');
      await page.getByRole('button', { name: '厨力支持', exact: true }).click();
      await page.getByLabel('搜索人物').fill('fixture-0');
      await page.locator('.support-directory article').getByRole('button', { name: '加入支持' }).click();
      await switchTab(page, '皮肤'); await switchTab(page, '人物');
      assert.equal(await page.locator('.support-draft-person').count(), 1, 'Unsaved support draft survives switching');
      assert.equal(await page.getByLabel('搜索人物').inputValue(), 'fixture-0');
      assert.equal(voteCalls(model), 0); assert.equal(taskCalls(model), 0);
      await switchTab(page, '皮肤');
      await openFirst(page);
      await noOverflow(page, 'skin-detail');
      await option(page, '合成服饰').getByRole('button', { name: '放大合成服饰完整立绘' }).click();
      await page.getByRole('dialog', { name: '完整立绘', exact: true }).waitFor();
      assert.equal(voteCalls(model), 0, 'Preview never votes');
      await page.getByRole('button', { name: '关闭大图', exact: true }).click();
      await selectSkin(page, '合成服饰');
      assert.equal(await card(page).getAttribute('data-appearance-id'), forms[0].default_appearance_id, 'Draft does not change directory art');
      for (const name of ['基础立绘', '精英二', '合成服饰']) await option(page, name).getByRole('button', { name: '加入比较' }).click();
      assert.equal(await skinDialog(page).locator('.choice-comparison figure').count(), 3);
      assert.equal(voteCalls(model), 0, 'Temporary comparison never votes');
      await noOverflow(page, 'three-way-comparison');
      model.choiceGate = deferred();
      await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).click();
      await until(() => model.choices.length === 1, 'Choice request started');
      assert.equal(await card(page).getAttribute('data-appearance-id'), forms[0].default_appearance_id, 'Pending request does not change directory art');
      model.choiceGate.resolve(); model.choiceGate = null;
      await skinDialog(page).getByText('已保存你的选择。', { exact: true }).waitFor();
      await skinDialog(page).getByRole('button', { name: '返回目录' }).click();
      await until(async () => await card(page).getAttribute('data-appearance-id') === 'synthetic-art-0-2', 'Successful save changes personal card');
      await page.reload(); await card(page).waitFor();
      assert.equal(await card(page).getAttribute('data-appearance-id'), 'synthetic-art-0-2', 'Reload restores saved personal art');
      await openFirst(page); await selectSkin(page, '基础立绘');
      model.choiceStatus = 503;
      await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).click();
      await skinDialog(page).getByRole('alert').waitFor();
      assert.equal(await card(page).getAttribute('data-appearance-id'), 'synthetic-art-0-2', 'Failed save preserves previous card');
      assert.equal(await option(page, '基础立绘').getByRole('button', { name: '已暂选' }).getAttribute('aria-pressed'), 'true');
      const failureKey = model.choices.at(-1).payload.operation_key;
      const failurePayload = clone(model.choices.at(-1));
      assert.equal(await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).isDisabled(), true, 'Unknown result locks new writes');
      model.choiceStatus = 200;
      await skinDialog(page).getByRole('button', { name: '重试原登记', exact: true }).click();
      await skinDialog(page).getByText('已保存你的选择。', { exact: true }).waitFor();
      assert.equal(model.choices.at(-1).payload.operation_key, failureKey, 'Unknown-outcome retry preserves operation key');
      assert.deepEqual(model.choices.at(-1), failurePayload, 'Retry preserves the original object and complete parameters');
      await skinDialog(page).getByRole('button', { name: '返回目录' }).click();
      await until(async () => await card(page).getAttribute('data-appearance-id') === 'synthetic-art-0-0', 'Retry accepted');
      // 浏览历史必须恢复同页形态；草稿不因返回目录而自动提交或丢失。
      await openFirst(page); await selectSkin(page, '合成服饰');
      const writesBeforeHistory = voteCalls(model);
      await page.goBack(); await until(async () => await page.locator('.skins-view dialog.preference-detail[open]').count() === 0, 'Back closes detail');
      await page.goForward(); await skinDialog(page).waitFor();
      assert.equal(await option(page, '合成服饰').getByRole('button', { name: '已暂选' }).getAttribute('aria-pressed'), 'true', 'History restores temporary choice');
      assert.equal(voteCalls(model), writesBeforeHistory);
      await skinDialog(page).getByRole('button', { name: '返回目录' }).click();
      const externallyChanged = model.state.choices.find(x => x.object_id === forms[0].id);
      externallyChanged.version++; externallyChanged.choice_id = 'synthetic-art-0-1';
      await switchTab(page, '人物'); await switchTab(page, '皮肤'); await openFirst(page);
      await skinDialog(page).getByText('另一页面已更新选择。', { exact: false }).waitFor();
      assert.equal(await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).isDisabled(), true, 'Stale draft cannot overwrite another page');
      assert.equal(voteCalls(model), writesBeforeHistory);
      await page.goto(`${base}/preferences/?tab=skins&form=${forms[0].id}`); await skinDialog(page).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('form'), forms[0].id);
      assert.equal(voteCalls(model), writesBeforeHistory, 'Direct link does not vote');
      // 新名录保留原登记；完整预览失败时不得通过隐藏候选绕过确认。
      const newAppearance = { ...model.catalog.appearances[2], id: 'synthetic-new-outfit', name: '合成新增服饰', image_url: '/__preferences_fixture__/new-outfit.svg', thumbnail_url: '/__preferences_fixture__/new-thumb.svg' };
      model.catalog.appearances.push(newAppearance); model.catalog.forms[0].appearance_ids.push(newAppearance.id); model.catalog.forms[0].catalog_version = 'synthetic-form-v2';
      externallyChanged.confirmed = false; externallyChanged.available = true;
      model.blockedImage = newAppearance.image_url;
      await page.reload(); await skinDialog(page).waitFor();
      await until(() => model.imageFailures > 0, 'Synthetic new image must fail');
      assert.equal(await skinDialog(page).locator('.choice-option').count(), 4, 'Image failure does not shrink candidate set');
      assert.equal(await card(page).getAttribute('data-appearance-id'), 'synthetic-art-0-1', 'New catalog preserves old personal art');
      const confirmOld = skinDialog(page).getByRole('button', { name: '保持原选择', exact: true });
      assert.equal(await confirmOld.isDisabled(), true, 'Catalog cannot be confirmed before all images load');
      assert.equal(voteCalls(model), writesBeforeHistory, 'Catalog and image failure do not vote');
      model.blockedImage = '';
      await skinDialog(page).getByRole('button', { name: '重试图片', exact: true }).click();
      await until(async () => await confirmOld.isEnabled(), 'Recovered image enables catalog confirmation');
      const previousVersion = externallyChanged.version;
      await confirmOld.click();
      await skinDialog(page).getByText('已保存你的选择。', { exact: true }).waitFor();
      const confirmed = model.state.choices.find(x => x.object_id === forms[0].id);
      assert.equal(confirmed.choice_id, 'synthetic-art-0-1'); assert.equal(confirmed.version, previousVersion + 1, 'Reconfirmation advances optimistic state version');
      assert.equal(model.state.choices.filter(x => x.object_id === forms[0].id).length, 1, 'Reconfirmation retains exactly one current choice');
      assert.equal(confirmed.catalog_version, 'synthetic-form-v2');
      const beforeWithdrawal = voteCalls(model);
      model.catalog.appearances.find(x => x.id === confirmed.choice_id).eligible = false;
      model.catalog.forms[0].catalog_version = 'synthetic-form-v3'; confirmed.confirmed = false; confirmed.available = false;
      await page.reload(); await skinDialog(page).waitFor();
      assert.equal(await skinDialog(page).getByRole('button', { name: '保持原选择', exact: true }).count(), 0, 'Withdrawn appearance cannot be reconfirmed');
      assert.equal(model.state.choices.find(x => x.object_id === forms[0].id).choice_id, 'synthetic-art-0-1', 'Withdrawal never silently rewrites historical choice');
      assert.equal(voteCalls(model), beforeWithdrawal);
      await skinDialog(page).getByRole('button', { name: '返回目录' }).click();
      await switchTab(page, '人物');
      if (viewport.width === 1440) {
        model.emptySnapshot = true;
        await page.getByRole('button', { name: '榜单与趋势', exact: true }).click();
        await until(async () => await page.locator('.preference-results table tbody tr').count() === persons.length, 'Empty real-shaped snapshot renders all candidate rows');
        const scoreCells = await page.locator('.preference-results table tbody tr td:nth-child(3)').allTextContents();
        assert.ok(scoreCells.every(value => value.trim() === '—'), 'Null uncertainty endpoints render without invented numeric scores');
        assert.deepEqual(errors, [], 'Empty comparison snapshot must not call toFixed on null interval endpoints');
        model.emptySnapshot = false;
      }
      await page.getByRole('button', { name: '随机选择', exact: true }).click();
      assert.equal(taskCalls(model), 0, 'View and history changes never dispatch tasks');
      await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
      await until(async () => await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), 'Both representative images loaded');
      assert.equal(taskCalls(model), 1);
      await noOverflow(page, 'random-pair');
      model.answerGate = deferred();
      await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().click();
      await until(() => model.calls.some(x => x.path.includes('/answer/')), 'Delayed answer request started');
      await switchTab(page, '皮肤');
      model.answerGate.resolve(); model.answerGate = null;
      await until(() => model.records.length === 1, 'Hidden answer accepted');
      await page.waitForTimeout(200);
      assert.equal(taskCalls(model), 1, 'Answer completing in hidden character view does not dispatch next task');
      await switchTab(page, '人物');
      assert.equal(taskCalls(model), 1, 'Returning to characters does not dispatch automatically');
      await page.getByRole('button', { name: '个人练习', exact: true }).click();
      await until(async () => await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), 'Practice image pair loaded');
      const beforePractice = voteCalls(model);
      await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().click();
      assert.equal(voteCalls(model), beforePractice, 'Personal practice never reaches public vote endpoints');
      await switchTab(page, '皮肤');
      await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-synthetic-directory.png`) });
      await noOverflow(page, 'final-directory');
      assert.deepEqual(model.forbidden, [], 'No request escaped the explicit mock contract');
      assert.deepEqual(errors, [], 'No browser runtime errors');
      report.viewports.push({ ...viewport, passed: true, requests: model.calls.length, votes: voteCalls(model), task_dispatches: taskCalls(model) });
      console.log(`PASS ${viewport.width}x${viewport.height}: synthetic skin save/retry/history, drafts, eight professions, hidden-answer dispatch, practice isolation, overflow`);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-failure.png`), fullPage: true }).catch(() => {});
      report.viewports.push({ ...viewport, passed: false, error: error.message });
      throw error;
    } finally { model.choiceGate?.resolve(); model.answerGate?.resolve(); await context.close(); }
  }
  for (const width of [1440, 390]) {
    await regression(`random-next-pair-keeps-illustrations-${width}`, async (page, model) => {
      await page.goto(`${base}/preferences/?tab=characters`);
      await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
      const choices = page.getByRole('button', { name: '更喜欢这位', exact: true });
      await until(async () => await choices.first().isEnabled(), 'Initial pair ready');
      const names = await page.locator('.random-person h3').allTextContents();
      const pairLayout = () => page.locator('.random-pair').evaluate(element => ({ top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight }));
      const before = await pairLayout();
      model.taskPair = persons.slice(2, 4); model.taskGate = deferred();
      model.delayedImage = model.taskPair[1].representative_url; model.imageGate = deferred();
      await choices.first().click();
      await until(() => model.records.length === 1 && taskCalls(model) === 2, 'Answer accepted, next dispatch waiting');
      await page.getByText('正在准备下一题…', { exact: true }).waitFor();
      assert.deepEqual(await page.locator('.random-person h3').allTextContents(), names);
      assert.equal(await page.locator('.random-pair .preference-image[data-image-state="ready"]').count(), 2);
      assert.equal(await page.locator('.random-view .preference-empty').count(), 0, 'Next dispatch never restores the start screen');
      assert.equal(await choices.first().isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '暂不判断，跳过', exact: true }).isDisabled(), true);
      assert.deepEqual(await pairLayout(), before, 'Loading status does not move the illustrations');
      model.taskGate.resolve(); model.taskGate = null;
      await until(() => model.imageRequests.includes(model.delayedImage), 'Next pair image is being preloaded');
      assert.deepEqual(await page.locator('.random-person h3').allTextContents(), names, 'Both old illustrations stay while one new image is delayed');
      await page.locator('.random-view').screenshot({ path: path.join(output, `random-next-loading-${width}.png`) });
      model.imageGate.resolve(); model.imageGate = null;
      await until(async () => (await page.locator('.random-person h3').allTextContents())[0] === persons[2].name && await choices.first().isEnabled(), 'Decoded next pair replaces both previous illustrations');
      assert.deepEqual(await page.locator('.random-person h3').allTextContents(), persons.slice(2, 4).map(x => x.name));
      assert.equal(model.records.length, 1); assert.equal(model.state.quota.weekly_used, 2);
      model.taskStatus = 503;
      await choices.first().click();
      const retry = page.getByRole('button', { name: '重试下一题', exact: true });
      await retry.waitFor();
      assert.deepEqual(await page.locator('.random-person h3').allTextContents(), persons.slice(2, 4).map(x => x.name));
      assert.equal(await choices.first().isDisabled(), true, 'Answered pair cannot be answered again after dispatch failure');
      assert.equal(await page.locator('.random-view .preference-empty').count(), 0);
      const failedDispatch = clone(model.calls.filter(x => x.path === '/api/preferences/tasks/').at(-1));
      model.taskStatus = 200; model.taskPair = persons.slice(4, 6);
      await retry.click();
      await until(async () => (await page.locator('.random-person h3').allTextContents())[0] === persons[4].name && await choices.first().isEnabled(), 'Retry recovers the next pair');
      assert.deepEqual(model.calls.filter(x => x.path === '/api/preferences/tasks/').at(-1), failedDispatch, 'Uncertain dispatch retries reuse the same operation');
      assert.equal(model.records.length, 2); assert.equal(model.state.quota.weekly_used, 3);
      await noOverflow(page, 'random-next-pair');
    }, { viewport: { width, height: 900 } });
  }
  await regression('random-next-image-failure-and-quota-end', async (page, model) => {
    model.state.quota.remaining = 2;
    await page.goto(`${base}/preferences/?tab=characters`);
    await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
    const choices = page.getByRole('button', { name: '更喜欢这位', exact: true });
    await until(async () => await choices.first().isEnabled(), 'Initial image pair ready');
    model.taskPair = persons.slice(2, 4); model.blockedImage = persons[2].representative_url;
    await choices.first().click();
    await page.locator('.random-pair').getByRole('button', { name: '重试图片', exact: true }).waitFor();
    assert.equal(await choices.first().isDisabled(), true, 'Failed preload does not lock the page or permit a blind vote');
    model.blockedImage = '';
    await page.locator('.random-pair').getByRole('button', { name: '重试图片', exact: true }).click();
    await until(async () => await choices.first().isEnabled(), 'Image retry enables the new pair');
    await choices.first().click();
    await page.getByRole('heading', { name: '本期正式比较已用完', exact: true }).waitFor();
    assert.equal(taskCalls(model), 2, 'Exhausted quota does not dispatch or preload another task');
    assert.equal(model.records.length, 2);
  });
  await regression('fifty-answer-rest-and-resume', async (page, model) => {
    await page.goto(`${base}/preferences/?tab=characters`);
    await page.getByRole('button', {name:'开始随机选择',exact:true}).click();
    for (let n=1;n<=50;n++) {
      await until(async()=>model.records.length===n-1 && await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().isEnabled(), `Answer ${n} ready`);
      await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().click();
      await until(()=>model.records.length===n, `Answer ${n} accepted`);
      if (n<50) await until(()=>taskCalls(model)===n+1, `Next task after ${n}`);
    }
    await page.getByRole('heading',{name:'已经完成 50 道，可以歇一会儿',exact:true}).waitFor();
    assert.equal(taskCalls(model),50); assert.equal(model.state.quota.weekly_used,50);
    await page.getByRole('button',{name:'继续选择',exact:true}).click();
    await until(()=>taskCalls(model)===51,'Continue immediately without resetting quota');
    assert.equal(model.state.quota.weekly_used,51);
  });
  await regression('unmount-keeps-original-unknown-answer', async (page, model) => {
    await page.goto(`${base}/preferences/?tab=characters`);
    await page.getByRole('button',{name:'开始随机选择',exact:true}).click();
    await until(async()=>await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().isEnabled(),'Task ready');
    model.loseAnswerOnce=true;
    await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().click();
    await page.getByRole('button',{name:'重试原选择',exact:true}).waitFor();
    const original=clone(model.calls.find(x=>x.path.includes('/answer/')));
    await page.locator('a[href="/sources/"]').first().click();
    await page.getByRole('heading',{name:'来源与版权',exact:true}).waitFor();
    await page.locator('nav a[href="/preferences/"]').click();
    await page.getByRole('button',{name:'重试原选择',exact:true}).waitFor();
    assert.equal(taskCalls(model),1);assert.equal(model.records.length,1);
    model.answerGate=deferred();
    await page.getByRole('button',{name:'重试原选择',exact:true}).click();
    await until(()=>model.calls.filter(x=>x.path.includes('/answer/')).length===2,'Original retry after remount');
    assert.deepEqual(model.calls.filter(x=>x.path.includes('/answer/'))[1],original);
    await page.locator('a[href="/sources/"]').first().click();
    await page.getByRole('heading',{name:'来源与版权',exact:true}).waitFor();
    model.answerGate.resolve();model.answerGate=null;
    await page.waitForTimeout(250);
    assert.equal(taskCalls(model),1);assert.equal(model.records.length,1);
  });
  await regression('identity-paused-public-reading', async (page, model) => {
    model.identityStatus = 503; model.config.writes_enabled = false;
    await page.goto(`${base}/preferences/?tab=characters`);
    await page.getByText(/只读/).first().waitFor();
    const resultsTab = page.getByRole('button', { name: '榜单与趋势', exact: true });
    if (await resultsTab.count()) await resultsTab.click();
    await page.getByRole('heading', { name: '样本积累中', exact: true }).waitFor();
    assert.ok(model.calls.some(x => x.path === '/api/preferences/rankings/'), 'Public rankings remain readable without identity');
    await switchTab(page, '皮肤'); await card(page).waitFor();
    assert.equal(await page.locator('.skin-card').count(), 9);
    await openFirst(page); await selectSkin(page, '合成服饰');
    assert.equal(await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).isDisabled(), true, 'Read-only mode never enables writes');
    assert.equal(voteCalls(model), 0); assert.equal(taskCalls(model), 0);
  });
  await regression('live-catalog-refresh-and-conflict', async (page, model) => {
    await page.goto(`${base}/preferences/?tab=skins`); await card(page).waitFor();
    const identityCount = () => model.calls.filter(x => x.path === '/api/preferences/identity/').length;
    const initialIdentities = identityCount();
    function publish(number) {
      const art = { ...model.catalog.appearances[2], id: `live-new-${number}`, name: `实时新增服饰${number}`, image_url: `/__preferences_fixture__/live-${number}.svg`, thumbnail_url: `/__preferences_fixture__/live-thumb-${number}.svg` };
      model.catalog.appearances.push(art); model.catalog.forms[0].appearance_ids.push(art.id);
      model.catalog.forms[0].catalog_version = `live-form-v${number}`;
      model.catalog.version = `live-catalog-v${number}`; model.state.catalog_version = model.catalog.version;
    }
    publish(2);
    await switchTab(page, '人物'); await switchTab(page, '皮肤');
    await card(page).click(); await skinDialog(page).waitFor();
    await until(async () => await skinDialog(page).locator('.choice-option').count() === 4, 'Returning to skins fetches the new catalog before choosing');
    assert.equal(identityCount(), initialIdentities, 'Catalog synchronization does not recreate identity');
    assert.equal(voteCalls(model), 0);
    publish(3);
    await selectSkin(page, '合成服饰');
    await until(async () => await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).isEnabled(), 'Current visible candidates loaded');
    await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).click();
    await until(async () => await skinDialog(page).locator('.choice-option').count() === 5, 'catalog_conflict triggers a fresh complete catalog without reload');
    assert.equal(model.state.choices.length, 0, 'Rejected obsolete catalog does not save a choice');
    const select = option(page, '合成服饰').getByRole('button', { name: '选为最爱', exact: true });
    if (await select.count()) await select.click();
    await until(async () => await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).isEnabled(), 'New complete catalog is ready for confirmation');
    await skinDialog(page).getByRole('button', { name: '确认最爱', exact: true }).click();
    await skinDialog(page).getByText('已保存你的选择。', { exact: true }).waitFor();
    assert.equal(model.state.choices[0].catalog_version, 'live-form-v3');
    assert.equal(identityCount(), initialIdentities);
  });
  for (const refreshedPending of ['null', 'other-task']) await regression(`lost-answer-retry-${refreshedPending}`, async (page, model) => {
    await page.goto(`${base}/preferences/?tab=characters`);
    await page.getByRole('button', { name: '开始随机选择', exact: true }).click();
    await until(async () => await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().isEnabled(), 'Original task images loaded');
    const original = clone(model.state.pending_task); model.loseAnswerOnce = true;
    await page.getByRole('button', { name: '更喜欢这位', exact: true }).first().click();
    await page.getByRole('button', { name: '重试原选择', exact: true }).waitFor();
    assert.equal(model.records.length, 1, 'Server accepted original answer before simulated response loss');
    const originalCall = clone(model.calls.find(x => x.path.includes('/answer/')));
    if (refreshedPending === 'other-task') model.state.pending_task = { ...original, id: 'synthetic-other-tab-task', left_id: persons[2].id, right_id: persons[3].id, left: persons[2], right: persons[3] };
    await switchTab(page, '皮肤'); await card(page).waitFor(); await switchTab(page, '人物');
    await page.getByRole('button', { name: '重试原选择', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.random-person h3').allTextContents(), [persons[0].name, persons[1].name], 'Unknown result keeps the original task visible after state refresh');
    assert.equal(taskCalls(model), 1, 'No replacement task is dispatched while the previous answer is unresolved');
    assert.equal(await page.getByRole('button', { name: '个人练习', exact: true }).isDisabled(), true);
    model.answerGate = deferred();
    await page.getByRole('button', { name: '重试原选择', exact: true }).click();
    await until(() => model.calls.filter(x => x.path.includes('/answer/')).length === 2, 'Original answer retry sent');
    const retried = model.calls.filter(x => x.path.includes('/answer/'))[1];
    assert.equal(retried.path, originalCall.path); assert.deepEqual(retried.payload, originalCall.payload, 'Retry preserves original task, intent and operation key');
    await switchTab(page, '皮肤');
    const stateReads = model.calls.filter(x => x.path === '/api/preferences/state/').length;
    const acceptedResponse = page.waitForResponse(response => new URL(response.url()).pathname === originalCall.path && response.status() === 200);
    model.answerGate.resolve(); model.answerGate = null; await acceptedResponse;
    await until(() => model.calls.filter(x => x.path === '/api/preferences/state/').length > stateReads, 'Accepted retry refreshes personal state');
    assert.equal(model.records.length, 1, 'Idempotent retry does not count the accepted answer twice');
    assert.equal(taskCalls(model), 1, 'Hidden successful retry does not dispatch another task');
  });
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
