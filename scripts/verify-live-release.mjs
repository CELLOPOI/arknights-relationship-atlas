// 仅对明确授权的可丢弃演练库执行真实 UI 写入，不访问现有业务库。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';

assert.equal(process.env.ATLAS_LIVE_REHEARSAL, '1', 'Set ATLAS_LIVE_REHEARSAL=1 only for a disposable rehearsal.');
assert.ok(process.env.BASE_URL, 'Set BASE_URL explicitly; there is no default database target.');
const target = new URL(process.env.BASE_URL);
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled.');
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only localhost rehearsal targets are allowed.');
const localHttps = target.protocol === 'https:';
assert.ok(target.protocol === 'http:' || localHttps, 'Only HTTP or explicitly authorized local HTTPS is allowed.');
assert.ok(!target.username && !target.password && !target.search && !target.hash, 'BASE_URL must contain only the local origin.');
if (localHttps) {
  assert.equal(process.env.ATLAS_LOCAL_HTTPS, '1', 'Set ATLAS_LOCAL_HTTPS=1 for the local Caddy rehearsal.');
  const caFile = process.env.NODE_EXTRA_CA_CERTS;
  assert.ok(caFile && path.isAbsolute(caFile), 'Start Node with NODE_EXTRA_CA_CERTS pointing to the exported local CA.');
  const certificate = new X509Certificate(await fs.readFile(caFile));
  assert.ok(certificate.ca, 'NODE_EXTRA_CA_CERTS must contain the exported CA certificate.');
}
assert.notEqual(target.port, '8000', 'The existing business service is not a rehearsal target.');
assert.equal(target.pathname, '/');
const base = target.origin;
const expectedRelease = 'rehearsal-revert';
async function requireRehearsal() {
  const response = await fetch(`${base}/api/ready/`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.equal(response.status, 200, 'Rehearsal readiness failed.');
  const status = await response.json();
  assert.equal(status.dataRelease?.id, expectedRelease, 'Refusing writes outside the disposable rehearsal release.');
  return status;
}
const ready = await requireRehearsal();
const credentialFile = process.env.ATLAS_BROWSER_CREDENTIALS;
assert.ok(credentialFile, 'Set ATLAS_BROWSER_CREDENTIALS to the private rehearsal credentials JSON.');
const credentials = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
assert.ok(typeof credentials.username === 'string' && typeof credentials.password === 'string');
const output = await verificationDirectory('live-release');
const run = randomUUID().slice(0, 8);
const checks = [], pageErrors = [];
const cleanError = error => String(error.message || error).split(credentials.password).join('[redacted]').slice(0, 2500);
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
let candidateId, feedbackPath, relationBefore;
async function context(viewport) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500, acceptDownloads: true, serviceWorkers: 'block',
    // 仅浏览器局部例外；每次写入前的 Node 请求仍校验指定 CA 和主机名。
    ignoreHTTPSErrors: localHttps });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      try { await requireRehearsal(); } catch { return route.abort(); }
    }
    return route.continue();
  });
  ctx.on('page', page => { page.setDefaultTimeout(45000); page.on('pageerror', error => pageErrors.push(cleanError(error))); });
  return ctx;
}
async function check(name, action) {
  try { await action(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: cleanError(error) }); throw error; }
  finally { console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`); }
}
async function readApi(page, route) {
  return page.evaluate(async route => { const response = await fetch(route); if (!response.ok) throw new Error(`Read failed: ${response.status}`); return response.json(); }, route);
}
async function feedback(page, mode) {
  await page.goto(base + '/#home', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '反馈问题', exact: true }).click();
  const dialog = page.locator('#feedback-dialog');
  await dialog.locator('#feedback-type').selectOption('site_issue');
  await dialog.locator('#feedback-description').fill(`临时演练 ${run} ${mode}：仅验证私有反馈收件，不修改正式资料。`);
  const received = page.waitForResponse(response => response.url().endsWith('/api/feedback/') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '提交反馈', exact: true }).click();
  const response = await received;
  assert.equal(response.status(), 202);
  assert.equal(response.request().headers()['x-csrftoken']?.length > 0, true);
  assert.deepEqual(await response.json(), { detail: '反馈已收到，维护者会核查。' });
  await dialog.getByRole('status').waitFor();
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await page.screenshot({ path: path.join(output, `${mode}-feedback.png`), fullPage: true });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
}
const visitorContext = await context({ width: 1440, height: 1000 });
const visitor = await visitorContext.newPage();
try {
  await check('desktop anonymous feedback reaches the real private queue with CSRF', () => feedback(visitor, 'desktop'));
  await check('anonymous CSRF failure and private-list denial are enforced', async () => {
    const statuses = await visitor.evaluate(async () => ({
      missingCsrf: (await fetch('/api/feedback/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'other', description: 'must be rejected' }) })).status,
      privateList: (await fetch('/api/feedback/')).status,
      community: (await fetch('/api/comments/')).status,
    }));
    assert.deepEqual(statuses, { missingCsrf: 403, privateList: 405, community: 403 });
  });
  await check('real graph, original relationship evidence and game load', async () => {
    await visitor.goto(base + '/?faction=rhodes&person=char_003_kalts#graph', { waitUntil: 'networkidle' });
    await visitor.waitForFunction(() => window.relationshipAtlas?.getState().nodeCount === 396);
    await visitor.locator('#open-list').click();
    await visitor.locator('[data-detail]').first().click();
    await visitor.locator('.dossier-quote').waitFor();
    const relationId = await visitor.locator('[data-community="relationship"]').getAttribute('data-target');
    relationBefore = await readApi(visitor, `/api/relationships/${encodeURIComponent(relationId)}/`);
    assert.ok(relationBefore.evidence.length && relationBefore.quote.trim());
    assert.equal((await visitor.locator('.dossier-quote').textContent()).trim(), relationBefore.quote.trim());
    await visitor.screenshot({ path: path.join(output, 'relationship-evidence.png'), fullPage: true });
    await visitor.goto(base + '/game/', { waitUntil: 'networkidle' });
    await visitor.locator('.game-play').waitFor();
    assert.ok(await visitor.locator('[data-next-id]').count());
    await visitor.screenshot({ path: path.join(output, 'game.png'), fullPage: true });
  });
  const mobileContext = await context({ width: 390, height: 844 });
  const mobile = await mobileContext.newPage();
  await check('mobile anonymous feedback completes without horizontal overflow', () => feedback(mobile, 'mobile'));
  await mobileContext.close();
  const adminContext = await context({ width: 1440, height: 1050 });
  const admin = await adminContext.newPage();
  await check('maintainer logs in and processes only the rehearsal feedback', async () => {
    await admin.goto(base + '/admin/login/?next=/admin/', { waitUntil: 'networkidle' });
    await admin.locator('#id_username').fill(credentials.username);
    await admin.locator('#id_password').fill(credentials.password);
    await Promise.all([admin.waitForURL('**/admin/'), admin.locator('input[type="submit"]').click()]);
    await admin.goto(base + `/admin/atlas/feedback/?q=${run}`, { waitUntil: 'networkidle' });
    assert.equal(await admin.locator('#result_list tbody tr').count(), 2);
    feedbackPath = await admin.locator('#result_list tbody tr th a').first().getAttribute('href');
    await admin.locator('#result_list tbody tr th a').first().click();
    await admin.locator('#id_status').selectOption('resolved');
    await admin.locator('#id_review_note').fill(`演练 ${run}：收件和后台状态保存已确认。`);
    await Promise.all([admin.waitForURL('**/admin/atlas/feedback/**'), admin.locator('input[name="_save"]').click()]);
    await admin.goto(new URL(feedbackPath, base).href, { waitUntil: 'networkidle' });
    assert.equal(await admin.locator('#id_status').inputValue(), 'resolved');
    assert.ok((await admin.locator('#id_review_note').inputValue()).includes(run));
    await admin.screenshot({ path: path.join(output, 'feedback-processed.png'), fullPage: true });
  });
  await check('an existing authenticated maintainer also cannot write legacy community data', async () => {
    const denied = await admin.evaluate(async () => {
      const token = document.cookie.split('; ').find(value => value.startsWith('csrftoken='))?.split('=')[1];
      const session = await (await fetch('/api/session/')).json();
      const response = await fetch('/api/favorites/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(token) }, body: JSON.stringify({ targetType: 'person', targetId: 'char_003_kalts' }) });
      return { authenticated: Boolean(session.user), status: response.status, code: (await response.json()).code };
    });
    assert.deepEqual(denied, { authenticated: true, status: 403, code: 'community_disabled' });
  });
  await check('real evidence candidate fields save sources while formal evidence stays unchanged', async () => {
    const evidence = relationBefore.evidence[0];
    await admin.goto(base + `/admin/atlas/evidence/${evidence.id}/change/`, { waitUntil: 'networkidle' });
    await admin.getByRole('link', { name: '创建资料候选', exact: true }).click();
    await admin.getByRole('button', { name: '创建候选', exact: true }).click();
    await admin.locator('#id_record_quote').waitFor();
    candidateId = new URL(admin.url()).pathname.match(/candidate\/(\d+)\/change/)[1];
    const stale = await adminContext.newPage();
    await stale.goto(admin.url(), { waitUntil: 'networkidle' });
    const quote = `${evidence.quote}\n【临时演练 ${run}：仅为候选输入，不是正式原文。】`;
    await admin.locator('#id_record_quote').fill(quote);
    await admin.locator('#id_sources-0-kind').selectOption('manual');
    await admin.locator('#id_sources-0-source').fill(`临时演练/${run}/候选来源说明`);
    await admin.locator('#id_sources-0-line').fill('1');
    await admin.locator('#id_sources-0-endLine').fill('2');
    await admin.locator('#id_sources-0-version').fill(`rehearsal-${run}`);
    await admin.locator('#id_private_note').fill(`PRIVATE-NOTE-${run}`);
    await admin.getByRole('button', { name: '保存候选', exact: true }).click();
    await admin.waitForLoadState('networkidle');
    assert.equal(await admin.locator('#id_version_token').inputValue(), '2');
    assert.equal(await admin.locator('#id_record_quote').inputValue(), quote);
    assert.ok((await admin.locator('#content table').filter({ hasText: '候选内容' }).textContent()).includes(`rehearsal-${run}`));
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Candidate differences must fit the viewport.');
    await admin.screenshot({ path: path.join(output, 'candidate-preview.png'), fullPage: true, mask: [admin.locator('#id_private_note')] });
    await stale.locator('#id_record_quote').fill(`${evidence.quote}\n【旧页面，应拒绝保存】`);
    await stale.getByRole('button', { name: '保存候选', exact: true }).click();
    await stale.getByText('候选已被其他维护者更新，请重新打开核对后再保存。', { exact: true }).waitFor();
    await stale.close();
    assert.deepEqual(await readApi(visitor, `/api/relationships/${encodeURIComponent(relationBefore.id)}/`), relationBefore);
  });
  await check('UI ZIP export matches saved fields and contains no private note', async () => {
    const downloadReady = admin.waitForEvent('download');
    await admin.getByRole('button', { name: '导出已保存版本', exact: true }).click();
    const download = await downloadReady;
    const file = path.join(output, `candidate-${candidateId}.zip`);
    await download.saveAs(file);
    // 本地读取下载内容；不调用后端 ORM 或写入任何正式资料。
    const summary = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read("candidate-manifest.json")); rows=[json.loads(z.read(n)) for n in z.namelist() if n.startswith("source/")]; print(json.dumps({"manifest":m,"rows":rows,"private_leaked":any(sys.argv[2].encode() in z.read(n) for n in z.namelist())},ensure_ascii=False))',
      file, `PRIVATE-NOTE-${run}`], { encoding: 'utf8' }));
    assert.equal(summary.private_leaked, false);
    assert.equal(summary.manifest.base_release, expectedRelease);
    assert.equal(summary.manifest.candidate_version, 2);
    assert.equal(summary.rows[0].sources[0].version, `rehearsal-${run}`);
    assert.ok(summary.rows[0].quote.includes(`临时演练 ${run}`));
    assert.deepEqual(await readApi(visitor, `/api/relationships/${encodeURIComponent(relationBefore.id)}/`), relationBefore);
  });
  await adminContext.close();
  assert.deepEqual(pageErrors, []);
} catch (error) {
  console.error(cleanError(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ run, base, release: ready.dataRelease,
    checks, pageErrors, candidateId, feedbackPath, note: 'Only private rehearsal feedback/candidate records were created; no formal data or external GitHub writes.' }, null, 2));
}
