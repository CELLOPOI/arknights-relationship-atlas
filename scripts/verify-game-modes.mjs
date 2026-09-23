import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { gameGraph, installGameFixture } from './game-ui-fixture.mjs';
import { buildNetwork, dataFingerprint, newRound, shortestPath } from '../frontend/src/game/network.ts';
import { newCompletionRound, canFillGap } from '../frontend/src/game/completion.ts';
import { modeRules, STORAGE_KEY } from '../frontend/src/game/modes.ts';
import { appearancesFor } from '../frontend/src/game/appearances.ts';
import { siteNotice } from '../frontend/src/content/site-notice.ts';

const base = process.env.BASE_URL || 'http://127.0.0.1:5175';
const output = await verificationDirectory('game-modes');
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
const people = new Map(gameGraph.nodes.map(person => [person.id, person]));
const byName = name => gameGraph.nodes.find(person => person.name === name);
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function page(viewport = { width: 1440, height: 1000 }) {
  const p = await browser.newPage({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 760, isMobile: viewport.width < 760 });
  p.setDefaultTimeout(10000);
  p.on('pageerror', error => errors.push(error.message));
  // 游戏回归从已阅读站点说明的会话开始；弹窗自身由站点说明验收覆盖。
  await p.addInitScript(version => localStorage.setItem('atlas:site-notice:acknowledged', version), siteNotice.version);
  await installGameFixture(p);
  return p;
}
async function ready(p) { await p.goto(`${base}/game/`); await p.locator('.game-play').waitFor(); await p.evaluate(() => document.fonts.ready); }
async function saved(p) { return p.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY); }
async function chooseMode(p, mode) { await p.locator(`[data-mode="${mode}"]`).click(); await p.waitForFunction(({ key, mode }) => JSON.parse(localStorage.getItem(key))?.mode === mode, { key: STORAGE_KEY, mode }); }
async function capture(p, filename) {
  await p.waitForFunction(() => [...document.querySelectorAll('.game-portrait-front.loaded')].filter(img => img.complete && img.naturalWidth > 0).length === 2);
  await p.evaluate(() => Promise.all([...document.querySelectorAll('img')].filter(img => { const box = img.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).map(img => img.decode().catch(() => {}))));
  assert.equal(await p.locator('.game-portrait').count(), 2);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.game-workspace').scrollWidth <= document.querySelector('.game-workspace').clientWidth + 1), true);
  const overlaps = await p.evaluate(() => {
    const play = document.querySelector('.game-play').getBoundingClientRect();
    return [...document.querySelectorAll('.game-portrait')].some(el => { const r = el.getBoundingClientRect(); return Math.min(r.right, play.right) - Math.max(r.left, play.left) > 1 && Math.min(r.bottom, play.bottom) - Math.max(r.top, play.top) > 1; });
  });
  assert.equal(overlaps, false);
  await p.screenshot({ path: path.join(output, filename), fullPage: true });
}

const desktop = await page();
try {
  await check('ordinary mode hides relationship judgments before submission and limits hints to one exclusion per gap', async () => {
    await ready(desktop);
    const state = await saved(desktop);
    assert.equal(state.mode, 'completion');
    const session = state.sessions.completion;
    assert.equal(session.rules.scope, 'operators');
    const question = session.completion;
    const net = buildNetwork(gameGraph, session.rules);
    const options = question.options[question.activeGap];
    const right = options.find(id => canFillGap(net, question, question.activeGap, id));
    const wrong = options.find(id => !canFillGap(net, question, question.activeGap, id));
    for (const id of options) {
      await desktop.locator(`[data-completion-id="${id}"] .game-completion-inspect`).click();
      assert.equal(await desktop.locator('.game-clue-panel').count(), 0);
      assert.equal(await desktop.getByText('暂无已收录连线', { exact: true }).count(), 0);
      assert.equal(await desktop.locator('.game-evidence[open]').count(), 0);
    }
    assert.equal((await saved(desktop)).sessions.completion.completion.attempts, 0);
    await capture(desktop, 'desktop-completion.png');
    if (wrong) {
      await desktop.locator(`[data-completion-id="${wrong}"] .game-completion-fill`).click();
      assert.equal(Object.keys((await saved(desktop)).sessions.completion.completion.answers).length, 0);
      await desktop.getByText('这位人物不能同时连接两侧，请重新选择。', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: '提示：排除一人', exact: true }).click();
      assert.equal(await desktop.locator('.game-completion-candidates li.excluded').count(), 1);
      assert.equal(await desktop.getByRole('button', { name: /本空位提示已用/ }).isDisabled(), true);
      assert.equal((await saved(desktop)).sessions.completion.completion.hintedGaps.length, 1);
    }
    await desktop.locator(`[data-completion-id="${right}"] .game-completion-fill`).click();
    await desktop.getByRole('heading', { name: '路线已补全', exact: true }).waitFor();
    assert.equal(await desktop.locator('#completion-result-title').evaluate(el => el === document.activeElement), true);
    await desktop.locator('.game-solution > ol .game-solution-edge').first().click();
    await desktop.locator('.game-evidence blockquote').first().waitFor();
    await desktop.keyboard.press('Escape');
  });

  await check('three modes preserve independent rounds through switching and reload', async () => {
    const completion = (await saved(desktop)).sessions.completion;
    await chooseMode(desktop, 'explore');
    const initial = (await saved(desktop)).sessions.explore;
    assert.equal(initial.rules.scope, 'operators');
    const next = initial.round.puzzle.shortestPath[1];
    await desktop.locator(`[data-next-id="${next}"]`).click();
    const explore = (await saved(desktop)).sessions.explore;
    await capture(desktop, 'desktop-explore.png');
    await chooseMode(desktop, 'input');
    const input = (await saved(desktop)).sessions.input;
    assert.equal(input.rules.scope, 'operators');
    assert.equal(await desktop.locator('[data-next-id]').count(), 0);
    assert.equal(await desktop.locator('.game-play').getAttribute('data-start-id'), input.round.puzzle.startId);
    assert.equal(await desktop.locator('.game-play').getAttribute('data-target-id'), input.round.puzzle.targetId);
    await capture(desktop, 'desktop-input.png');
    await desktop.reload(); await desktop.locator('#game-name-input').waitFor();
    await chooseMode(desktop, 'completion');
    assert.deepEqual((await saved(desktop)).sessions.completion, completion);
    await chooseMode(desktop, 'explore');
    assert.deepEqual((await saved(desktop)).sessions.explore, explore);
    await chooseMode(desktop, 'input');
    assert.deepEqual((await saved(desktop)).sessions.input, input);
  });

  await check('typed search supports true names, nicknames, fragments, ambiguous matches and IME without exposing neighbors', async () => {
    const field = desktop.getByLabel('输入下一位人物', { exact: true });
    const before = (await saved(desktop)).sessions.input.round;
    for (const [query, name] of [['小羊', '艾雅法拉'], ['阿黛尔', '艾雅法拉'], ['小火龙', '伊芙利特'], ['４２', '史尔特尔'], ['水陈', '陈'], ['德克', '德克萨斯']]) {
      await field.fill(query);
      await desktop.locator(`[data-name-id="${byName(name).id}"]`).waitFor();
    }
    await field.press('Enter');
    assert.deepEqual((await saved(desktop)).sessions.input.round, before);
    await desktop.getByText('请从下方确认具体人物，再连线。', { exact: true }).waitFor();
    await field.fill(people.get(before.puzzle.shortestPath[1]).name);
    await field.dispatchEvent('compositionstart');
    await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    assert.deepEqual((await saved(desktop)).sessions.input.round, before);
    await field.dispatchEvent('compositionend');
    await field.fill('no-such-person-9284');
    await desktop.getByText('没有匹配的人物，试试其他称呼。', { exact: true }).waitFor();
    await desktop.getByRole('button', { name: '清除输入的名字' }).click();
    assert.equal(await field.inputValue(), '');
  });

  await check('typed submissions reject banned, repeated and unlinked people without consuming a step, then reach the supplied target', async () => {
    const session = (await saved(desktop)).sessions.input;
    const before = session.round;
    const net = buildNetwork(gameGraph, session.rules);
    const field = desktop.getByLabel('输入下一位人物', { exact: true });
    const wrong = gameGraph.nodes.find(person => net.people.has(person.id) && person.id !== before.path[0] && !net.neighbors.get(before.path[0]).has(person.id));
    for (const id of [session.rules.bannedIds[0], before.path[0], wrong.id]) {
      await field.fill(people.get(id).name);
      await desktop.locator(`[data-name-id="${id}"]`).click();
      assert.deepEqual((await saved(desktop)).sessions.input.round, before);
    }
    for (const id of before.puzzle.shortestPath.slice(1)) {
      await field.fill(people.get(id).name);
      await field.press('Enter');
      await desktop.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key)).sessions.input.round.path.at(-1) === id, { key: STORAGE_KEY, id });
    }
    await desktop.locator('.game-result[data-result="won"]').waitFor();
    assert.equal((await saved(desktop)).sessions.input.round.path.at(-1), before.puzzle.targetId);
    await desktop.getByRole('button', { name: '重试本题' }).click();
    assert.deepEqual((await saved(desktop)).sessions.input.round.path, [before.puzzle.startId]);
  });

  await check('ordinary difficulties show one, two and three gaps, preserve partial progress and keep settings independent', async () => {
    await chooseMode(desktop, 'completion');
    const inputRules = (await saved(desktop)).sessions.input.rules;
    for (const [label, count] of [['入门', 1], ['标准', 2], ['挑战', 3]]) {
      await desktop.getByRole('button', { name: /规则与禁用/ }).click();
      await desktop.getByRole('radio', { name: new RegExp(`${label} ${count} 处空位`) }).check();
      await desktop.getByRole('button', { name: '应用并开始新题' }).click();
      await desktop.locator('.game-settings').waitFor({ state: 'hidden' });
      assert.equal((await saved(desktop)).sessions.completion.completion.gaps.length, count);
      assert.equal(await desktop.locator('.game-completion-route button').count(), count);
    }
    const question = (await saved(desktop)).sessions.completion.completion;
    assert.equal(question.gaps.length, 3);
    await capture(desktop, 'desktop-three-gaps.png');
    await desktop.setViewportSize({ width: 360, height: 780 });
    await capture(desktop, 'narrow-three-gaps.png');
    await desktop.setViewportSize({ width: 1440, height: 1000 });
    const answer = question.puzzle.shortestPath[question.activeGap];
    await desktop.locator(`[data-completion-id="${answer}"] .game-completion-fill`).click();
    const partial = (await saved(desktop)).sessions.completion.completion;
    await desktop.reload(); await desktop.locator('.game-completion').waitFor();
    assert.deepEqual((await saved(desktop)).sessions.completion.completion, partial);
    await desktop.getByRole('button', { name: '结束本局并看答案', exact: true }).click();
    await desktop.locator('.game-result[data-result="revealed"]').waitFor();
    assert.equal(await desktop.locator('.game-completion-fill').count(), 0);
    await desktop.getByRole('button', { name: '重试本题', exact: true }).click();
    assert.equal(Object.keys((await saved(desktop)).sessions.completion.completion.answers).length, 0);
    assert.deepEqual((await saved(desktop)).sessions.input.rules, inputRules);
  });

  await check('all three modes retain both portraits, working elite swaps, and responsive touch layouts', async () => {
    const p = await page({ width: 390, height: 844 });
    // 固定有两阶段立绘的人物，只隔离题目，不改变规则或可走连线。
    const rules = modeRules('explore'), net = buildNetwork(gameGraph, rules);
    const start = byName('德克萨斯').id, target = byName('史尔特尔').id;
    const path = shortestPath(net, start, target);
    rules.difficulty = path.length === 3 ? 'easy' : path.length <= 5 ? 'normal' : 'hard';
    const puzzle = { startId: start, targetId: target, shortestPath: path };
    const completionPuzzle = { startId: start, targetId: path[2], shortestPath: path.slice(0, 3) };
    const sessions = { completion: { rules: { ...rules, difficulty: 'easy' }, round: null, completion: newCompletionRound(net, completionPuzzle, 'easy', () => .4) },
      explore: { rules, round: newRound(puzzle), completion: null }, input: { rules, round: newRound(puzzle), completion: null } };
    await p.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key: STORAGE_KEY, state: { fingerprint: dataFingerprint(gameGraph), mode: 'completion', sessions } });
    await ready(p);
    for (const mode of ['completion', 'explore', 'input']) {
      await chooseMode(p, mode);
      await p.locator('.game-workspace').evaluate(el => { el.scrollTop = 0; });
      await capture(p, `mobile-${mode}.png`);
      const swap = p.locator('.game-portrait-current .game-portrait-switch');
      await swap.waitFor();
      const previous = await p.locator('.game-portrait-current').getAttribute('data-art-phase');
      await swap.tap();
      await p.waitForFunction(previous => document.querySelector('.game-portrait-current').dataset.artPhase !== previous, previous);
      const interaction = p.locator(mode === 'completion' ? '.game-completion-inspect' : mode === 'input' ? '#game-name-input' : '[data-next-id]').first();
      await interaction.scrollIntoViewIfNeeded();
      await capture(p, `mobile-${mode}-play.png`);
      if (mode === 'completion') await interaction.tap();
      else if (mode === 'input') {
        await interaction.fill('小羊');
        await p.locator(`[data-name-id="${byName('艾雅法拉').id}"]`).waitFor();
        await capture(p, 'mobile-input-search.png');
      }
      await p.setViewportSize({ width: 844, height: 390 });
      await capture(p, `landscape-${mode}.png`);
      await p.setViewportSize({ width: 360, height: 780 });
      await capture(p, `narrow-${mode}.png`);
      await p.setViewportSize({ width: 390, height: 844 });
    }
    await p.close();
  });

  await check('all modes reveal expandable valid alternatives and keep their evidence available', async () => {
    const p = await page();
    const rules = { ...modeRules('completion'), difficulty: 'easy' };
    const net = buildNetwork(gameGraph, rules);
    let path;
    for (const start of net.people.keys()) {
      for (const target of net.people.keys()) {
        if (start === target || net.neighbors.get(start).has(target)) continue;
        const common = [...net.neighbors.get(start).keys()].filter(id => net.neighbors.get(target).has(id));
        if (common.length >= 2) { path = [start, common[0], target]; break; }
      }
      if (path) break;
    }
    assert.ok(path);
    const puzzle = { startId: path[0], targetId: path[2], shortestPath: path };
    const sessions = { completion: { rules, round: null, completion: newCompletionRound(net, puzzle, 'easy', () => .4) },
      explore: { rules, round: newRound(puzzle), completion: null }, input: { rules, round: newRound(puzzle), completion: null } };
    await p.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key: STORAGE_KEY, state: { fingerprint: dataFingerprint(gameGraph), mode: 'completion', sessions } });
    await ready(p);
    for (const mode of ['completion', 'explore', 'input']) {
      await chooseMode(p, mode);
      await p.getByRole('button', { name: '结束本局并看答案', exact: true }).click();
      const alternatives = p.locator('.game-other-solutions');
      assert.equal(await alternatives.getAttribute('open'), null);
      await alternatives.locator('summary').click();
      assert.ok(await p.locator('.game-alternate-route').count() > 0);
      await p.locator('.game-alternate-route .game-solution-edge').first().click();
      await p.locator('.game-evidence blockquote').first().waitFor();
      await p.keyboard.press('Escape');
      if (mode === 'completion') await capture(p, 'expanded-answers.png');
    }
    await p.close();
  });

  await check('alternate forms appear in every mode, retain art after reload and share repeat and ban rules', async () => {
    const p = await page();
    const rules = { ...modeRules('completion'), difficulty: 'easy' };
    const net = buildNetwork(gameGraph, rules);
    const start = byName('德克萨斯').id, middle = byName('拉普兰德').id;
    assert.ok(net.neighbors.get(start).has(middle));
    const target = [...net.neighbors.get(middle).keys()].find(id => id !== start && !net.neighbors.get(start).has(id));
    assert.ok(target);
    const puzzle = { startId: start, targetId: target, shortestPath: [start, middle, target] };
    const appearances = { [start]: 'char_1028_texas2' };
    const sessions = { completion: { rules, appearances, round: null, completion: newCompletionRound(net, puzzle, 'easy', () => .4) },
      explore: { rules, appearances, round: newRound(puzzle), completion: null }, input: { rules, appearances, round: newRound(puzzle), completion: null } };
    await p.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key: STORAGE_KEY, state: { fingerprint: dataFingerprint(gameGraph), mode: 'completion', sessions } });
    await ready(p);
    for (const mode of ['completion', 'explore', 'input']) {
      await chooseMode(p, mode);
      assert.equal(await p.locator('.game-portrait-current').getAttribute('data-appearance-id'), 'char_1028_texas2');
      await p.waitForFunction(() => document.querySelector('.game-portrait-current .game-portrait-front.loaded')?.src.includes('char_1028_texas2-base'));
    }
    const field = p.getByLabel('输入下一位人物', { exact: true });
    await field.fill('异德'); await field.press('Enter');
    assert.equal((await saved(p)).sessions.input.round.path.length, 1);
    await field.fill(appearancesFor(people.get(middle))[0].name); await field.press('Enter');
    await p.waitForFunction(id => document.querySelector('.game-portrait-current').dataset.appearanceId === id, appearancesFor(people.get(middle))[0].id);
    await p.reload(); await p.locator('#game-name-input').waitFor();
    assert.equal(await p.locator('.game-portrait-current').getAttribute('data-appearance-id'), appearancesFor(people.get(middle))[0].id);
    await p.locator('.game-portrait-current .game-portrait-switch').click();
    await p.waitForFunction(() => document.querySelector('.game-portrait-current').dataset.artPhase === 'elite2');
    await capture(p, 'alternate-elite2.png');
    await p.setViewportSize({ width: 390, height: 844 });
    await capture(p, 'mobile-alternate.png');
    await p.close();
  });

  await check('new questions reset typed text even when the only available pair and start are unchanged', async () => {
    const p = await page();
    const rules = modeRules('input');
    const net = buildNetwork(gameGraph, rules);
    let trio;
    for (const [start, neighbors] of net.neighbors) {
      for (const middle of neighbors.keys()) {
        const target = [...net.neighbors.get(middle).keys()].find(id => id !== start && !neighbors.has(id));
        if (target) { trio = [start, middle, target]; break; }
      }
      if (trio) break;
    }
    assert.ok(trio);
    const selected = [...trio].sort();
    const start = selected.filter(id => id !== trio[1])[0];
    const target = trio.find(id => id !== start && id !== trio[1]);
    rules.difficulty = 'easy'; rules.bannedIds = gameGraph.nodes.map(person => person.id).filter(id => !trio.includes(id));
    const question = { startId: start, targetId: target, shortestPath: [start, trio[1], target] };
    const state = { fingerprint: dataFingerprint(gameGraph), mode: 'input', sessions: { input: { rules, round: newRound(question), completion: null } } };
    await p.addInitScript(({ key, state }) => { Math.random = () => .1; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key: STORAGE_KEY, state });
    await ready(p);
    await p.getByLabel('输入下一位人物', { exact: true }).fill('no-such-person-9284');
    await p.getByRole('button', { name: '换一道题', exact: true }).click();
    assert.equal((await saved(p)).sessions.input.round.puzzle.startId, start);
    assert.equal(await p.getByLabel('输入下一位人物', { exact: true }).inputValue(), '');
    await p.close();
  });

  await check('browser has no uncaught errors', async () => assert.deepEqual(errors, []));
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ base, checks, errors }, null, 2));
  await browser.close();
}
if (checks.some(check => !check.pass)) process.exitCode = 1;
