import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { gameGraph, installGameFixture } from './game-ui-fixture.mjs';
import { buildNetwork, dataFingerprint } from '../frontend/src/game/network.ts';
import { modeRules, STORAGE_KEY } from '../frontend/src/game/modes.ts';
import { isRecognitionBridge, knowsEachOther, newRecognitionRound } from '../frontend/src/game/recognition.ts';
import { appearancesFor } from '../frontend/src/game/appearances.ts';

const base = process.env.BASE_URL || 'http://127.0.0.1:5175';
const output = await verificationDirectory('game-recognition');
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
const pairKey = pair => [pair.leftId, pair.rightId].sort().join('|');
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function page() {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  p.setDefaultTimeout(10000);
  p.on('pageerror', error => errors.push(error.message));
  await installGameFixture(p);
  return p;
}
async function saved(p) { return p.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY); }
async function mode(p, name) {
  await p.locator(`[data-mode="${name}"]`).click();
  await p.waitForFunction(({ key, name }) => JSON.parse(localStorage.getItem(key))?.mode === name, { key: STORAGE_KEY, name });
}
async function seed(p, state) {
  await p.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key: STORAGE_KEY, state });
}
async function ready(p) { await p.goto(`${base}/game/`); await p.locator('.game-play').waitFor(); await p.evaluate(() => document.fonts.ready); }
async function feedback(p, choice, correct) {
  const selected = p.locator(`[data-answer="${choice}"]`);
  assert.equal(await selected.getAttribute('data-result'), correct ? 'correct' : 'wrong');
  assert.equal(await selected.isDisabled(), true);
  assert.equal(await selected.locator('small').innerText(), correct ? '正确' : '错误');
  assert.equal(await p.locator('.game-recognition-option').count(), 2);
  const color = await selected.evaluate(el => ({ color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity }));
  const [red, green, blue] = color.color.match(/[\d.]+/g).map(Number);
  assert.ok(correct ? green > red && green > blue : red > green && red > blue);
  assert.equal(color.opacity, '1');
  const before = (await saved(p)).sessions.recognition.recognition;
  await p.locator(`[data-answer="${!choice}"]`).evaluate(el => el.click());
  assert.deepEqual((await saved(p)).sessions.recognition.recognition, before);
}
async function bridge(p, net, pair, correct = true) {
  await p.getByRole('heading', { name: '通过谁认识？', exact: true }).waitFor();
  assert.equal(await p.locator('.game-result, .game-solution').count(), 0);
  assert.equal(await p.getByRole('button', { name: '下一题', exact: true }).count(), 0);
  assert.equal(await p.getByRole('button', { name: '确认中间人', exact: true }).isDisabled(), true);
  for (const id of pair.options) {
    await p.locator(`[data-bridge-id="${id}"]`).click();
    assert.equal(await p.locator('.game-result, .game-solution').count(), 0);
  }
  const id = pair.options.find(id => isRecognitionBridge(net, pair, id) === correct);
  assert.ok(id);
  await p.locator(`[data-bridge-id="${id}"]`).click();
  await p.getByRole('button', { name: '确认中间人', exact: true }).click();
  return id;
}
async function capture(p, file) {
  await p.waitForFunction(() => [...document.querySelectorAll('.game-portrait-front.loaded')].filter(img => img.complete && img.naturalWidth > 0).length === 2);
  await p.evaluate(() => Promise.all([...document.querySelectorAll('.game-portrait img')].map(img => img.decode().catch(() => {}))));
  assert.equal(await p.evaluate(() => {
    const workspace = document.querySelector('.game-workspace');
    return document.documentElement.scrollWidth <= innerWidth && workspace.scrollWidth <= workspace.clientWidth + 1;
  }), true);
  assert.equal(await p.evaluate(() => {
    const play = document.querySelector('.game-play').getBoundingClientRect();
    return [...document.querySelectorAll('.game-portrait')].some(el => {
      const rect = el.getBoundingClientRect();
      return Math.min(rect.right, play.right) - Math.max(rect.left, play.left) > 1 && Math.min(rect.bottom, play.bottom) - Math.max(rect.top, play.top) > 1;
    });
  }), false);
  if (file) await p.screenshot({ path: path.join(output, file), fullPage: true });
}

const desktop = await page();
try {
  await check('operator-only 5:5 batch judges on one click and retains readable locked feedback', async () => {
    await ready(desktop);
    assert.equal((await saved(desktop)).mode, 'completion');
    await mode(desktop, 'recognition');
    const session = (await saved(desktop)).sessions.recognition;
    const net = buildNetwork(gameGraph, session.rules);
    assert.equal(session.rules.scope, 'operators');
    assert.equal(session.recognition.questions.filter(pair => knowsEachOther(net, pair)).length, 5);
    assert.equal(new Set(session.recognition.questions.map(pairKey)).size, 10);
    assert.equal(await desktop.locator('.game-trail').count(), 0);
    assert.equal(await desktop.getByRole('button', { name: '确认判断', exact: true }).count(), 0);
    assert.equal(await desktop.locator('.game-result, .game-recognition-pool').count(), 0);
    assert.equal(await desktop.getByRole('button', { name: '查看关系原文', exact: true }).count(), 0);
    assert.deepEqual(session.recognition.answers, []);
    const answer = knowsEachOther(net, session.recognition.questions[0]);
    await desktop.locator(`[data-answer="${answer}"]`).click();
    await feedback(desktop, answer, true);
    await capture(desktop, 'desktop-correct.png');
    if (!answer) await bridge(desktop, net, session.recognition.questions[0]);
    await desktop.getByRole('heading', { name: '答对了', exact: true }).waitFor();
    assert.equal(await desktop.locator('#recognition-heading').evaluate(el => el === document.activeElement), true);
    assert.equal((await saved(desktop)).sessions.recognition.recognition.answers[0].knows, answer);
  });

  await check('mode switching and reload preserve the pair, result, score and appearance', async () => {
    const before = await saved(desktop);
    await mode(desktop, 'completion');
    assert.deepEqual((await saved(desktop)).sessions.completion.completion, before.sessions.completion.completion);
    await mode(desktop, 'recognition');
    await desktop.reload(); await desktop.locator('.game-recognition').waitFor();
    assert.deepEqual((await saved(desktop)).sessions.recognition, before.sessions.recognition);
    await desktop.getByRole('heading', { name: '答对了', exact: true }).waitFor();
  });

  await check('ten submissions settle once, expose real evidence after judging and restart with fresh pairs', async () => {
    const session = (await saved(desktop)).sessions.recognition;
    const net = buildNetwork(gameGraph, session.rules);
    let evidenceChecked = false;
    let pendingRestored = false;
    for (let index = 0; index < 10; index++) {
      if (index > 0) {
        await desktop.getByRole('button', { name: '下一题', exact: true }).click();
        await desktop.getByRole('heading', { name: '他们认识吗？', exact: true }).waitFor();
        assert.equal(await desktop.getByRole('button', { name: '确认判断', exact: true }).count(), 0);
        assert.equal(await desktop.locator('.game-recognition-option[data-result]').count(), 0);
        const truth = knowsEachOther(net, session.recognition.questions[index]);
        await desktop.locator(`[data-answer="${index % 2 === 0 ? truth : !truth}"]`).click();
        await feedback(desktop, index % 2 === 0 ? truth : !truth, index % 2 === 0);
        if (index === 1) {
          await desktop.setViewportSize({ width: 390, height: 844 });
          await desktop.locator('#recognition-question').evaluate(el => el.scrollIntoView({ block: 'start' }));
          await capture(desktop, 'mobile-wrong.png');
          await desktop.setViewportSize({ width: 1440, height: 1000 });
        }
        if (!truth) {
          if (!pendingRestored) {
            await desktop.getByRole('heading', { name: '通过谁认识？', exact: true }).waitFor();
            const pending = (await saved(desktop)).sessions.recognition;
            await mode(desktop, 'completion'); await mode(desktop, 'recognition');
            await desktop.reload(); await desktop.locator('.game-recognition-pool').waitFor();
            assert.deepEqual((await saved(desktop)).sessions.recognition, pending);
            pendingRestored = true;
          }
          await bridge(desktop, net, session.recognition.questions[index]);
        }
      }
      await desktop.getByRole('heading', { name: index % 2 === 0 ? '答对了' : '答错了', exact: true }).waitFor();
      const truth = knowsEachOther(net, session.recognition.questions[index]);
      assert.equal(await desktop.getByRole('button', { name: '查看关系原文', exact: true }).count(), Number(truth));
      if (truth && !evidenceChecked) {
        await desktop.getByRole('button', { name: '查看关系原文', exact: true }).click();
        await desktop.locator('.game-evidence[open] blockquote').first().waitFor();
        await desktop.getByRole('button', { name: '关闭关系依据', exact: true }).click();
        evidenceChecked = true;
      }
    }
    assert.equal(evidenceChecked, true);
    assert.equal(pendingRestored, true);
    assert.match(await desktop.locator('.game-recognition-summary').innerText(), /答对 5 \/ 10 题/);
    assert.equal(await desktop.getByRole('button', { name: '下一题', exact: true }).count(), 0);
    await desktop.getByRole('button', { name: '再玩一轮', exact: true }).click();
    await desktop.locator('.game-recognition-option:not(:disabled)').first().waitFor();
    const next = (await saved(desktop)).sessions.recognition.recognition;
    const previous = new Set(session.recognition.questions.map(pairKey));
    assert.equal(next.index, 0); assert.deepEqual(next.answers, []);
    assert.ok(next.questions.every(pair => !previous.has(pairKey(pair))));
  });

  await check('pool settings apply scope and bans, and impossible restrictions retain the current round', async () => {
    await desktop.getByRole('button', { name: /规则与禁用/ }).click();
    assert.equal(await desktop.locator('.game-difficulty').count(), 0);
    await desktop.locator('#game-scope').selectOption('all');
    await desktop.getByRole('button', { name: '应用并开始新一轮', exact: true }).click();
    await desktop.locator('.game-settings[open]').waitFor({ state: 'hidden' });
    assert.equal((await saved(desktop)).sessions.recognition.rules.scope, 'all');
    const bannedId = (await saved(desktop)).sessions.recognition.recognition.questions[0].leftId;
    const bannedName = gameGraph.nodes.find(person => person.id === bannedId).name;
    await desktop.getByRole('button', { name: /规则与禁用/ }).click();
    await desktop.getByLabel('搜索要禁用的人物').fill(bannedName);
    await desktop.getByRole('button', { name: `禁用${bannedName}`, exact: true }).click();
    await desktop.getByRole('button', { name: '应用并开始新一轮', exact: true }).click();
    await desktop.locator('.game-settings[open]').waitFor({ state: 'hidden' });
    const filtered = (await saved(desktop)).sessions.recognition;
    assert.ok(filtered.rules.bannedIds.includes(bannedId));
    assert.ok(filtered.recognition.questions.every(pair => pair.leftId !== bannedId && pair.rightId !== bannedId));
    assert.ok(filtered.recognition.questions.every(pair => !pair.options.includes(bannedId)));

    const p = await page();
    const names = ['德克萨斯', '能天使', '陈', '星熊', '炎熔', '空'];
    const nodes = gameGraph.nodes.filter(person => names.includes(person.name));
    const ids = new Set(nodes.map(person => person.id));
    const data = { ...gameGraph, nodes, edges: gameGraph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    await p.route('**/api/graph/**', route => route.fulfill({ json: data }));
    await seed(p, { mode: 'recognition', sessions: {} });
    await ready(p);
    const before = (await saved(p)).sessions.recognition;
    await p.getByRole('button', { name: /规则与禁用/ }).click();
    await p.getByLabel('搜索要禁用的人物').fill('陈');
    await p.getByRole('button', { name: '禁用陈', exact: true }).click();
    await p.getByRole('button', { name: '应用并开始新一轮', exact: true }).click();
    await p.getByRole('alert').filter({ hasText: '当前人物池不足' }).waitFor();
    assert.deepEqual((await saved(p)).sessions.recognition, before);
    await p.getByRole('button', { name: '关闭规则设置', exact: true }).click();
    assert.equal(await p.locator('.game-recognition').count(), 1);
    await p.close();
  });

  await check('alternate art, keyboard judging and desktop, phone and landscape layouts stay usable', async () => {
    const p = await page();
    const rules = modeRules('recognition');
    const net = buildNetwork(gameGraph, rules);
    const texas = gameGraph.nodes.find(person => person.name === '德克萨斯');
    const sora = gameGraph.nodes.find(person => person.name === '空');
    const form = appearancesFor(texas)[0];
    const round = newRecognitionRound(net);
    const pair = { leftId: texas.id, rightId: sora.id, options: [] };
    const existing = round.questions.findIndex(value => pairKey(value) === pairKey(pair));
    const replace = existing >= 0 ? existing : round.questions.findIndex(value => knowsEachOther(net, value));
    round.questions[replace] = round.questions[0]; round.questions[0] = pair;
    await seed(p, { fingerprint: dataFingerprint(gameGraph), mode: 'recognition', sessions: {
      recognition: { rules, round: null, completion: null, recognition: round, appearances: { [texas.id]: form.id } },
    } });
    await ready(p);
    assert.equal(await p.locator('.game-portrait-current').getAttribute('data-appearance-id'), form.id);
    await capture(p, 'desktop.png');
    await p.locator('.game-portrait-current .game-portrait-switch').click();
    await p.waitForFunction(() => document.querySelector('.game-portrait-current').dataset.artPhase === 'elite2');
    assert.equal(await p.locator('.game-portrait-target').getAttribute('data-art-phase'), 'base');
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('#recognition-question').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await capture(p, 'mobile.png');
    await p.setViewportSize({ width: 360, height: 780 });
    await capture(p);
    await p.setViewportSize({ width: 844, height: 390 });
    await p.locator('#recognition-question').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await capture(p, 'landscape.png');
    const option = p.locator('[data-answer="true"]');
    await option.focus(); await p.keyboard.press('Space');
    await feedback(p, true, true);
    await p.getByRole('heading', { name: '答对了', exact: true }).waitFor();
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('#recognition-heading').scrollIntoViewIfNeeded();
    await capture(p, 'mobile-result.png');
    await p.close();
  });

  await check('indirect questions hide individual clues, settle a wrong intermediary and expand alternate answers', async () => {
    const p = await page();
    const rules = modeRules('recognition');
    const net = buildNetwork(gameGraph, rules);
    const round = newRecognitionRound(net);
    const index = round.questions.findIndex(pair => !knowsEachOther(net, pair));
    [round.questions[0], round.questions[index]] = [round.questions[index], round.questions[0]];
    await seed(p, { fingerprint: dataFingerprint(gameGraph), mode: 'recognition', sessions: {
      recognition: { rules, round: null, completion: null, recognition: round },
    } });
    await ready(p);
    assert.equal(await p.locator('.game-recognition-pool').count(), 0);
    await p.locator('[data-answer="false"]').click();
    await feedback(p, false, true);
    await p.locator('.game-recognition-pool').waitFor();
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.locator('.game-recognition-submit').scrollIntoViewIfNeeded();
    await capture(p, 'desktop-pool.png');
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('#recognition-heading').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await capture(p, 'mobile-pool.png');
    await bridge(p, net, round.questions[0], false);
    await p.getByRole('heading', { name: '答错了', exact: true }).waitFor();
    await p.getByText('已答 1 题 · 答对 0 题', { exact: true }).waitFor();
    const solutions = round.questions[0].options.filter(id => isRecognitionBridge(net, round.questions[0], id));
    if (solutions.length > 1) {
      await p.locator('.game-other-solutions summary').click();
      assert.equal(await p.locator('.game-alternate-route').count(), solutions.length - 1);
    }
    await p.locator('.game-solution-edge').first().click();
    await p.locator('.game-evidence[open] blockquote').first().waitFor();
    await p.close();
  });

  await check('browser has no uncaught errors', async () => assert.deepEqual(errors, []));
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ base, checks, errors }, null, 2));
  await browser.close();
}
if (checks.some(check => !check.pass)) process.exitCode = 1;
