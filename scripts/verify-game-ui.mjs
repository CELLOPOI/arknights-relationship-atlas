import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './playwright.mjs';
import { dataFingerprint } from '../frontend/src/game/network.ts';
import { STORAGE_KEY, LEGACY_STORAGE_KEY } from '../frontend/src/game/modes.ts';
import { gameGraph, installGameFixture } from './game-ui-fixture.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const output = await verificationDirectory('game');
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const checks = [], errors = [];
const storageKey = STORAGE_KEY;
const defaultBans = ['npc_b99957887950ebfd', 'char_002_amiya', 'char_003_kalts'];
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function page(viewport = { width: 1440, height: 1000 }) {
  const result = await browser.newPage({ viewport, reducedMotion: 'reduce', isMobile: viewport.width <= 430, hasTouch: viewport.width <= 430 });
  result.setDefaultTimeout(9000);
  result.on('pageerror', error => errors.push(error.message));
  if (process.env.MOCK_GAME_API === '1') await installGameFixture(result);
  return result;
}
async function ready(p) {
  await p.goto(base + '/game/', { waitUntil: 'networkidle' });
  await p.locator('.game-play').waitFor();
  await p.locator('[data-mode="explore"]').click();
  await p.evaluate(() => document.fonts.ready);
}
async function saved(p) { return p.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return { fingerprint: state.fingerprint, ...state.sessions[state.mode] }; }, storageKey); }
const desktop = await page();
const data = process.env.MOCK_GAME_API === '1' ? gameGraph : await (await desktop.request.get(base + '/api/graph/?scope=all')).json();
const people = new Map(data.nodes.map(person => [person.id, person]));
function adjacency(rules) {
  const available = new Set(data.nodes.filter(person => !rules.bannedIds.includes(person.id) && (rules.scope === 'all' || person.isOperator)).map(person => person.id));
  const links = new Map([...available].map(id => [id, new Set()]));
  for (const edge of data.edges) if (available.has(edge.source) && available.has(edge.target)) {
    links.get(edge.source).add(edge.target); links.get(edge.target).add(edge.source);
  }
  return links;
}
function route(links, source, target) {
  const previous = new Map([[source, null]]), queue = [source];
  for (let index = 0; index < queue.length && !previous.has(target); index++) for (const next of links.get(queue[index]) || []) {
    if (!previous.has(next)) { previous.set(next, queue[index]); queue.push(next); }
  }
  if (!previous.has(target)) return null;
  const result = []; for (let at = target; at !== null; at = previous.get(at)) result.unshift(at);
  return result;
}
async function move(p, id) { await p.locator(`[data-next-id="${id}"]`).click(); }
async function overflow(p) {
  return p.evaluate(() => {
    const roots = [document.documentElement, document.querySelector('.game-workspace'), ...document.querySelectorAll('dialog[open]')].filter(Boolean);
    return roots.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className || element.tagName);
  });
}

await check('archive navigation opens the independent game with all three default bans', async () => {
  await desktop.goto(base + '/#factions', { waitUntil: 'networkidle' });
  await desktop.locator('.site-nav a[href="/game/"]').click();
  await desktop.locator('.game-play').waitFor();
  await desktop.locator('[data-mode="explore"]').click();
  assert.equal(new URL(desktop.url()).pathname, '/game/');
  const state = await saved(desktop);
  assert.deepEqual(state.rules.bannedIds, defaultBans);
  assert.equal(state.rules.scope, 'operators');
  assert.equal(state.rules.difficulty, 'normal');
  assert.ok(!defaultBans.includes(state.round.puzzle.startId));
  assert.ok(!defaultBans.includes(state.round.puzzle.targetId));
  const answer = route(adjacency(state.rules), state.round.puzzle.startId, state.round.puzzle.targetId);
  assert.ok(answer.length >= 4 && answer.length <= 5);
  assert.equal(await desktop.evaluate(() => typeof window.relationshipAtlas), 'undefined');
  await desktop.evaluate(() => document.fonts.ready);
  await desktop.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  assert.deepEqual(await overflow(desktop), []);
});

await check('hints, legal moves, evidence, undo, and reload preserve the same round', async () => {
  const initial = await saved(desktop);
  await desktop.getByRole('button', { name: /提示下一人/ }).click();
  await desktop.locator('[data-hinted="true"]').waitFor();
  await desktop.getByRole('button', { name: /提示下一人/ }).click();
  assert.equal((await saved(desktop)).round.hintedPaths.length, 1);
  const next = await desktop.locator('[data-hinted="true"]').getAttribute('data-next-id');
  await move(desktop, next);
  assert.equal((await saved(desktop)).round.path.length, 2);
  await desktop.locator('.game-trail-edge').click();
  await desktop.locator('.game-evidence blockquote').first().waitFor();
  assert.ok((await desktop.locator('.game-evidence blockquote').first().innerText()).trim().length > 0);
  await desktop.getByRole('button', { name: '关闭关系依据' }).click();
  await desktop.reload({ waitUntil: 'networkidle' });
  assert.deepEqual((await saved(desktop)).round.path, [initial.round.puzzle.startId, next]);
  await desktop.getByRole('button', { name: '撤回一步' }).click();
  assert.equal((await saved(desktop)).round.path.length, 1);
  assert.equal((await saved(desktop)).round.moves, 1);
  assert.equal((await saved(desktop)).round.hintedPaths.length, 1);
});

await check('candidate search has a recoverable empty state and excludes banned or visited people', async () => {
  const input = desktop.getByRole('textbox', { name: '搜索可连接人物' });
  await input.fill('no-such-person-9284');
  await desktop.getByText('没有匹配的人物，试试其他名字或清除搜索。').waitFor();
  await desktop.getByRole('button', { name: '清除人物搜索' }).click();
  const state = await saved(desktop);
  const candidates = await desktop.locator('[data-next-id]').evaluateAll(elements => elements.map(element => element.dataset.nextId));
  assert.ok(candidates.length);
  assert.ok(candidates.every(id => !state.rules.bannedIds.includes(id) && !state.round.path.includes(id)));
});

await check('a valid path wins and the result displays the actual shortest distance', async () => {
  const state = await saved(desktop);
  const answer = route(adjacency(state.rules), state.round.puzzle.startId, state.round.puzzle.targetId);
  for (const id of answer.slice(1)) await move(desktop, id);
  await desktop.locator('[data-result="won"]').waitFor();
  assert.equal((await saved(desktop)).round.path.length, answer.length);
  assert.ok((await desktop.locator('.game-result-score').innerText()).includes(`最短 ${answer.length - 1} 步`));
  await desktop.getByRole('button', { name: '查看最短路线' }).click();
  assert.equal(await desktop.locator('.game-solution > ol > li').count(), answer.length);
  await desktop.screenshot({ path: path.join(output, 'result.png'), fullPage: true });
});

await check('custom ban search, cancellation, difficulty, scope, and persistence work', async () => {
  await desktop.getByRole('button', { name: /规则与禁用/ }).click();
  await desktop.getByRole('textbox', { name: '搜索要禁用的人物' }).fill('可露希尔');
  await desktop.locator('.game-ban-results').getByRole('button', { name: '禁用可露希尔', exact: true }).click();
  await desktop.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
  await desktop.getByRole('button', { name: '关闭规则设置' }).click();
  assert.deepEqual((await saved(desktop)).rules.bannedIds, defaultBans);
  await desktop.getByRole('button', { name: /规则与禁用/ }).click();
  await desktop.getByRole('textbox', { name: '搜索要禁用的人物' }).fill('可露希尔');
  await desktop.locator('.game-ban-results').getByRole('button', { name: '禁用可露希尔', exact: true }).click();
  await desktop.getByRole('radio', { name: /挑战/ }).check();
  await desktop.getByRole('button', { name: '应用并开始新题' }).click();
  await desktop.locator('.game-settings').waitFor({ state: 'hidden' });
  const state = await saved(desktop);
  assert.ok(state.rules.bannedIds.includes(people.values().find(person => person.name === '可露希尔').id));
  assert.equal(state.rules.difficulty, 'hard');
  const answer = route(adjacency(state.rules), state.round.puzzle.startId, state.round.puzzle.targetId);
  assert.ok(answer.length >= 6 && answer.length <= 7);
  await desktop.reload({ waitUntil: 'networkidle' });
  assert.deepEqual((await saved(desktop)).rules, state.rules);
  await desktop.getByRole('button', { name: /规则与禁用/ }).click();
  await desktop.locator('#game-scope').selectOption('operators');
  await desktop.getByRole('radio', { name: /入门/ }).check();
  await desktop.getByRole('button', { name: '恢复三巨头' }).click();
  await desktop.getByRole('button', { name: '应用并开始新题' }).click();
  await desktop.locator('.game-settings').waitFor({ state: 'hidden' });
  const operators = await saved(desktop);
  assert.equal(operators.rules.scope, 'operators');
  assert.ok(people.get(operators.round.puzzle.startId).isOperator && people.get(operators.round.puzzle.targetId).isOperator);
  for (const id of await desktop.locator('[data-next-id]').evaluateAll(elements => elements.map(element => element.dataset.nextId))) assert.ok(people.get(id).isOperator);
});

await check('six unsuccessful moves stop play; undo, reveal, and retry remain consistent', async () => {
  const state = await saved(desktop);
  const links = adjacency(state.rules);
  function detour(path) {
    if (path.length === 7) return path;
    for (const id of links.get(path.at(-1)) || []) {
      if (id === state.round.puzzle.targetId || path.includes(id)) continue;
      const found = detour([...path, id]); if (found) return found;
    }
    return null;
  }
  const path = detour([state.round.puzzle.startId]);
  assert.ok(path);
  for (const id of path.slice(1)) await move(desktop, id);
  await desktop.locator('[data-result="lost"]').waitFor();
  assert.equal(await desktop.locator('[data-next-id]').count(), 0);
  await desktop.getByRole('button', { name: '撤回一步' }).click();
  assert.equal((await saved(desktop)).round.path.length, 6);
  await desktop.getByRole('button', { name: '结束本局并看答案' }).click();
  await desktop.locator('[data-result="revealed"]').waitFor();
  assert.equal(await desktop.getByRole('button', { name: '撤回一步' }).isDisabled(), true);
  await desktop.getByRole('button', { name: '重试本题' }).click();
  assert.equal((await saved(desktop)).round.path.length, 1);
  assert.equal((await saved(desktop)).round.revealed, false);
});

await check('overly restrictive custom bans show an error without replacing the current round', async () => {
  const p = await page();
  const links = adjacency({ scope: 'all', bannedIds: defaultBans });
  let trio;
  for (const [a, adjacent] of links) {
    for (const b of adjacent) {
      const c = [...links.get(b)].find(id => id !== a && !adjacent.has(id));
      if (c) { trio = [a, b, c]; break; }
    }
    if (trio) break;
  }
  assert.ok(trio);
  const bans = data.nodes.map(person => person.id).filter(id => !trio.includes(id));
  await p.addInitScript(({ key, fingerprint, bans }) => localStorage.setItem(key, JSON.stringify({ fingerprint, rules: { scope: 'all', difficulty: 'easy', bannedIds: bans } })), { key: LEGACY_STORAGE_KEY, fingerprint: dataFingerprint(data), bans });
  await ready(p);
  const before = await saved(p);
  await p.getByRole('button', { name: /规则与禁用/ }).click();
  await p.getByRole('textbox', { name: '搜索要禁用的人物' }).fill(people.get(trio[1]).name);
  await p.locator('.game-ban-results').getByRole('button', { name: `禁用${people.get(trio[1]).name}`, exact: true }).click();
  await p.getByRole('button', { name: '应用并开始新题' }).click();
  await p.getByRole('alert').waitFor();
  assert.deepEqual(await saved(p), before);
  await p.close();
});

await check('phone and landscape layouts, touch controls, navigation, and reduced motion work', async () => {
  const p = await page({ width: 390, height: 844 });
  await ready(p);
  await p.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.deepEqual(await overflow(p), []);
  assert.equal(await p.locator('.game-candidates').evaluate(element => getComputedStyle(element).animationName), 'none');
  await p.getByRole('button', { name: /规则与禁用/ }).tap();
  await p.getByRole('textbox', { name: '搜索要禁用的人物' }).fill('阿米娅');
  await p.screenshot({ path: path.join(output, 'mobile-settings.png'), fullPage: true });
  assert.deepEqual(await overflow(p), []);
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: /提示下一人/ }).tap();
  await p.locator('[data-hinted="true"]').tap();
  assert.equal((await saved(p)).round.path.length, 2);
  await p.getByRole('button', { name: '打开导航' }).click();
  assert.equal((await p.locator('.site-menu a[aria-current="page"]').innerText()).replace(/\s+/g, ' '), 'GAME 游戏');
  await p.keyboard.press('Escape');
  await p.setViewportSize({ width: 844, height: 390 });
  await p.screenshot({ path: path.join(output, 'landscape.png'), fullPage: true });
  assert.deepEqual(await overflow(p), []);
  await p.setViewportSize({ width: 360, height: 780 });
  assert.deepEqual(await overflow(p), []);
  await p.close();
});

await check('API failures offer retry and recover without a page reload', async () => {
  const p = await page();
  await p.route('**/api/graph/**', route => route.abort());
  await p.goto(base + '/game/', { waitUntil: 'networkidle' });
  await p.getByRole('alert').waitFor();
  await p.unroute('**/api/graph/**');
  await p.getByRole('button', { name: '重新读取', exact: true }).click();
  await p.locator('.game-play').waitFor();
  await p.close();
});

await check('no uncaught browser errors', async () => assert.deepEqual(errors, []));
await fs.writeFile(path.join(output, 'ui-checks.json'), JSON.stringify({ base, checks, errors }, null, 2));
await browser.close();
if (checks.some(check => !check.pass)) process.exitCode = 1;
