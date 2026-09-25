import { assetVersions } from '../frontend/scripts/asset-delivery.mjs';
import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './playwright.mjs';
import { buildNetwork, dataFingerprint, defaultRules, newRound, shortestPath } from '../frontend/src/game/network.ts';

const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const output = await verificationDirectory('game-illustrations');
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
const key = 'arknights-six-links-v1';
const start = 'char_102_texas', target = 'char_350_surtr';
const desktop = await makePage();
const data = await (await desktop.request.get(base + '/api/graph/?scope=all')).json();
const index = await (await desktop.request.get(base + '/illustrations/index.json')).json();
const assetPrefix = `/media/${(await assetVersions()).atlas}`;
const illustrationURL = value => assetPrefix + value;
const network = buildNetwork(data, defaultRules());

async function makePage(viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce', isMobile: viewport.width <= 430, hasTouch: viewport.width <= 430 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  return page;
}
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function seed(page, from = start, to = target, visited = [from]) {
  const answer = shortestPath(network, from, to);
  assert.ok(answer && answer.length >= 3 && answer.length <= 7);
  const rules = { ...defaultRules(), difficulty: answer.length === 3 ? 'easy' : answer.length <= 5 ? 'normal' : 'hard' };
  const value = { fingerprint: dataFingerprint(data), rules, round: newRound({ startId: from, targetId: to, shortestPath: answer }) };
  value.round.path = visited;
  value.round.moves = visited.length - 1;
  await page.goto(base + '/game/', { waitUntil: 'domcontentloaded' });
  await page.locator('.game-play').waitFor();
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key, value });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.game-play').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return answer;
}
async function readyArt(page, side, id) {
  await page.locator(`.game-portrait-${side}[data-person-id="${id}"][data-art-state="ready"]`).waitFor();
  const image = page.locator(`.game-portrait-${side} .game-portrait-front`);
  assert.equal(await image.getAttribute('src'), illustrationURL(index.people[id].base.src));
  assert.ok(await image.evaluate(img => img.complete && img.naturalWidth > 100));
}
async function readyPhase(page, side, id, phase) {
  await page.waitForFunction(({ side, phase }) => {
    const portrait = document.querySelector(`.game-portrait-${side}`);
    return portrait?.dataset.artPhase === phase && !portrait.dataset.swapping;
  }, { side, phase });
  const portrait = page.locator(`.game-portrait-${side}`);
  assert.equal(await portrait.locator('.game-portrait-front').getAttribute('src'), illustrationURL(index.people[id][phase].src));
  assert.equal(await portrait.locator('.game-portrait-back').getAttribute('src'), illustrationURL(index.people[id][phase === 'base' ? 'elite2Portrait' : 'basePortrait'].src));
  assert.ok(await portrait.locator('.game-portrait-front').evaluate(img => img.complete && img.naturalWidth > 100));
}
async function noOverflow(page) {
  const overflow = await page.evaluate(() => [document.documentElement, document.querySelector('.game-workspace')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className || e.tagName));
  assert.deepEqual(overflow, []);
}
async function screenshot(page, name) {
  await page.evaluate(() => { document.querySelector('.game-workspace').scrollTop = 0; });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}

await check('operators render the correct base art over grayscale E2 art on opposite sides of play', async () => {
  await seed(desktop);
  await readyArt(desktop, 'current', start); await readyArt(desktop, 'target', target);
  for (const [side, id] of [['current', start], ['target', target]]) {
    const back = desktop.locator(`.game-portrait-${side} .game-portrait-back`);
    assert.equal(await back.getAttribute('src'), illustrationURL(index.people[id].elite2Portrait.src));
    assert.match(await back.evaluate(img => getComputedStyle(img).filter), /grayscale\(1\)/);
    assert.ok(await back.evaluate(img => img.complete && img.naturalWidth > 100));
  }
  const [left, play, right] = await Promise.all(['.game-portrait-current', '.game-play', '.game-portrait-target'].map(s => desktop.locator(s).boundingBox()));
  assert.ok(left.x + left.width <= play.x && play.x + play.width <= right.x);
  await noOverflow(desktop); await screenshot(desktop, 'desktop');
});

await check('moving, undoing, and resuming change only the current portrait', async () => {
  const answer = shortestPath(network, start, target);
  const requests = [];
  const listen = request => { if (request.url().includes('/illustrations/')) requests.push(request.url()); };
  desktop.on('request', listen);
  await desktop.locator(`[data-next-id="${answer[1]}"]`).click();
  await readyArt(desktop, 'current', answer[1]); await readyArt(desktop, 'target', target);
  assert.ok(!requests.some(url => url.includes(`${target}-`)), 'Target artwork should stay mounted');
  await desktop.reload({ waitUntil: 'networkidle' });
  await readyArt(desktop, 'current', answer[1]); await readyArt(desktop, 'target', target);
  await desktop.getByRole('button', { name: '撤回一步' }).click();
  await readyArt(desktop, 'current', start); await readyArt(desktop, 'target', target);
  desktop.off('request', listen);
});

await check('NPC portraits have a single full illustration and no E2 layer', async () => {
  const id = 'npc_00a043118c878e45';
  await seed(desktop, id);
  await readyArt(desktop, 'current', id); await readyArt(desktop, 'target', target);
  assert.equal(await desktop.locator('.game-portrait-current .game-portrait-back').count(), 0);
  assert.equal(await desktop.locator('.game-portrait-current .game-portrait-switch').count(), 0);
  await screenshot(desktop, 'npc');
  await seed(desktop, target, id);
  await readyArt(desktop, 'target', id);
  assert.equal(await desktop.locator('.game-portrait-target .game-portrait-back').count(), 0);
});

await check('operators without E2 and generic NPC sources are represented accurately', async () => {
  await seed(desktop, 'char_123_fang');
  await readyArt(desktop, 'current', 'char_123_fang');
  assert.equal(await desktop.locator('.game-portrait-current .game-portrait-back').count(), 0);
  assert.equal(await desktop.locator('.game-portrait-current .game-portrait-switch').count(), 0);
  const generic = Object.keys(index.people).find(id => index.people[id].generic && (shortestPath(network, id, target)?.length || 0) >= 3);
  assert.ok(generic);
  await seed(desktop, generic);
  await desktop.locator('.game-portrait-current').getByText(/剧情通用立绘/).waitFor();
  assert.equal(await desktop.locator('.game-portrait-current .game-portrait-back').count(), 0);
});

await check('mobile, narrow, tablet, and landscape layouts keep portraits and controls in bounds', async () => {
  for (const [name, viewport] of [
    ['mobile', { width: 390, height: 844 }],
    ['narrow', { width: 360, height: 780 }],
    ['tablet', { width: 1024, height: 768 }],
    ['landscape', { width: 844, height: 390 }],
  ]) {
    const page = await makePage(viewport);
    await seed(page); await readyArt(page, 'current', start); await readyArt(page, 'target', target);
    await noOverflow(page);
    const left = await page.locator('.game-portrait-current').boundingBox();
    const right = await page.locator('.game-portrait-target').boundingBox();
    assert.ok(left.x + left.width <= right.x + 1);
    assert.equal(await page.locator('.game-portrait-front').first().evaluate(img => getComputedStyle(img).transitionDuration), '0s');
    if (name !== 'narrow') await screenshot(page, name);
    const toggle = page.locator('.game-portrait-current .game-portrait-switch');
    if (viewport.width <= 430) await toggle.tap(); else await toggle.click();
    await readyPhase(page, 'current', start, 'elite2');
    if (name === 'mobile') await screenshot(page, 'mobile-elite2');
    const button = page.locator('[data-next-id]').first();
    const id = await button.getAttribute('data-next-id');
    if (viewport.width <= 430) await button.tap(); else await button.click();
    await readyArt(page, 'current', id); await readyArt(page, 'target', target);
    await page.close();
  }
});

await check('a failed illustration keeps gameplay usable and can be retried', async () => {
  const page = await makePage();
  await page.route(`**/illustrations/${start}-base.webp?*`, route => route.abort());
  await seed(page);
  await page.locator('.game-portrait-current[data-art-state="error"]').waitFor();
  assert.ok(await page.locator('[data-next-id]').count());
  assert.ok((await page.locator('.game-portrait-current .game-portrait-fallback > img').boundingBox()).width <= 80);
  await page.unroute(`**/illustrations/${start}-base.webp?*`);
  await page.locator('.game-portrait-current').getByRole('button', { name: '重试立绘' }).click();
  await readyArt(page, 'current', start);
  await page.close();
});

await check('a delayed previous portrait cannot replace the current character after undo', async () => {
  await seed(desktop);
  const next = shortestPath(network, start, target)[1];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await desktop.route(`**/illustrations/${next}-base.webp?*`, async route => { await blocked; await route.continue(); });
  await desktop.locator(`[data-next-id="${next}"]`).click();
  await desktop.locator(`.game-portrait-current[data-person-id="${next}"]`).waitFor();
  await desktop.getByRole('button', { name: '撤回一步' }).click();
  release();
  await readyArt(desktop, 'current', start);
  await desktop.waitForLoadState('networkidle');
  await readyArt(desktop, 'current', start);
  await desktop.unroute(`**/illustrations/${next}-base.webp?*`);
});

await check('the page requests only the two displayed characters and shares the index request', async () => {
  const page = await makePage();
  await seed(page);
  const requests = [];
  page.on('request', request => { if (request.url().includes('/illustrations/')) requests.push(request.url()); });
  await page.reload({ waitUntil: 'networkidle' });
  await readyArt(page, 'current', start); await readyArt(page, 'target', target);
  assert.equal(requests.filter(url => url.endsWith('/illustrations/index.json')).length, 1);
  assert.equal(requests.filter(url => url.includes('.webp')).length, 4);
  assert.ok(requests.every(url => url.startsWith(base + assetPrefix + '/illustrations/')));
  await page.close();
});

await check('the reported Haruka and Mio round never overlaps rules or blocks controls while scrolling', async () => {
  const visited = ['char_491_humus', 'char_4203_kichi', 'char_4202_haruka'];
  const npc = 'npc_08a5376de9194cbe';
  for (const viewport of [{ width: 1920, height: 900 }, { width: 1440, height: 780 }, { width: 2560, height: 1100 }]) {
    const page = await makePage(viewport);
    await seed(page, visited[0], npc, visited);
    await readyArt(page, 'current', visited.at(-1)); await readyArt(page, 'target', npc);
    const npcImage = await page.locator('.game-portrait-target .game-portrait-front').boundingBox();
    assert.ok(npcImage.height <= index.people[npc].base.height + 1, 'Small NPC originals must not be blown up');
    if (viewport.width === 1920) await screenshot(page, 'reported-pair');
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const geometry = await page.evaluate(async fraction => {
        const workspace = document.querySelector('.game-workspace');
        workspace.scrollTop = (workspace.scrollHeight - workspace.clientHeight) * fraction;
        await new Promise(requestAnimationFrame);
        const sidebar = document.querySelector('.game-sidebar').getBoundingClientRect();
        const stage = document.querySelector('.game-stage').getBoundingClientRect();
        return [...document.querySelectorAll('.game-portrait')].map(p => {
          const box = p.getBoundingClientRect();
          return { portraitBottom: box.bottom, stageBottom: stage.bottom, sidebarTop: sidebar.top };
        });
      }, fraction);
      assert.ok(geometry.every(g => g.portraitBottom <= g.stageBottom + 1 && g.portraitBottom < g.sidebarTop), JSON.stringify({ viewport, fraction, geometry }));
    }
    if (viewport.width === 1920) await page.screenshot({ path: path.join(output, 'scrolled-bottom.png'), fullPage: true });
    await page.locator('.game-sidebar').getByRole('button', { name: '修改', exact: true }).click();
    await page.locator('.game-settings[open]').waitFor();
    await page.getByRole('button', { name: '关闭规则设置' }).click();
    await page.locator('.game-trail-edge').first().click();
    await page.locator('.game-evidence blockquote').first().waitFor();
    await page.getByRole('button', { name: '关闭关系依据' }).click();
    await page.getByRole('button', { name: '换一道题', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.game-step.filled').length === 1);
    assert.equal(await page.locator('.game-step.filled').count(), 1);
    await noOverflow(page);
    await page.close();
  }
});

await check('clicking the rear artwork swaps both layers independently without changing the round', async () => {
  await seed(desktop);
  await readyArt(desktop, 'current', start); await readyArt(desktop, 'target', target);
  const saved = await desktop.evaluate(key => localStorage.getItem(key), key);
  for (const [side, id] of [['current', start], ['target', target]]) {
    const stage = await desktop.locator(`.game-portrait-${side} .game-portrait-stage`).boundingBox();
    // 点击露出的背景面部区域，确认不是只能点下方文字。
    await desktop.mouse.click(stage.x + stage.width * (side === 'current' ? .22 : .78), stage.y + stage.height * .22);
    await readyPhase(desktop, side, id, 'elite2');
  }
  assert.equal(await desktop.evaluate(key => localStorage.getItem(key), key), saved);
  await screenshot(desktop, 'desktop-elite2');
  await desktop.locator('.game-portrait-current .game-portrait-switch').click();
  await readyPhase(desktop, 'current', start, 'base');
  await readyPhase(desktop, 'target', target, 'elite2');
});

await check('keyboard users can swap and return with focus retained', async () => {
  const toggle = desktop.locator('.game-portrait-current .game-portrait-switch');
  await toggle.focus(); await desktop.keyboard.press('Enter');
  await readyPhase(desktop, 'current', start, 'elite2');
  assert.ok(await toggle.evaluate(button => document.activeElement === button));
  assert.match(await toggle.getAttribute('aria-label'), /切换至精一立绘/);
  await desktop.keyboard.press('Space');
  await readyPhase(desktop, 'current', start, 'base');
  assert.ok(await toggle.evaluate(button => document.activeElement === button));
});

await check('failed phase loads keep the old illustration and allow retry', async () => {
  const page = await makePage();
  await seed(page); await readyArt(page, 'current', start);
  const url = `**/illustrations/${start}-elite2.webp?*`;
  await page.route(url, route => route.abort());
  await page.locator('.game-portrait-current .game-portrait-switch').click();
  await page.getByRole('button', { name: '德克萨斯：重试精二立绘' }).waitFor();
  await readyPhase(page, 'current', start, 'base');
  assert.ok(await page.locator('[data-next-id]').count());
  await page.unroute(url);
  await page.getByRole('button', { name: '德克萨斯：重试精二立绘' }).click();
  await readyPhase(page, 'current', start, 'elite2');
  await page.close();
});

await check('late phase loads cannot change the next character and the target keeps its selected phase', async () => {
  const page = await makePage();
  await seed(page); await readyArt(page, 'current', start); await readyArt(page, 'target', target);
  await page.locator('.game-portrait-target .game-portrait-switch').click();
  await readyPhase(page, 'target', target, 'elite2');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route(`**/illustrations/${start}-elite2.webp?*`, async route => { await blocked; await route.continue(); });
  const toggle = page.locator('.game-portrait-current .game-portrait-switch');
  await toggle.click();
  // 真实重复点击仍会到达 aria-disabled 按钮；Playwright 的普通 click 会先等待启用。
  const box = await toggle.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await toggle.getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('.game-portrait-current .game-portrait-front').getAttribute('src'), illustrationURL(index.people[start].base.src));
  const next = shortestPath(network, start, target)[1];
  await page.locator(`[data-next-id="${next}"]`).click();
  release();
  await readyArt(page, 'current', next);
  await page.waitForLoadState('networkidle');
  await readyArt(page, 'current', next); await readyPhase(page, 'target', target, 'elite2');
  await page.getByRole('button', { name: '撤回一步' }).click();
  await readyArt(page, 'current', start); await readyPhase(page, 'target', target, 'elite2');
  await page.close();
});

await check('phase motion travels in opposite directions and respects reduced motion', async () => {
  const page = await makePage();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seed(page); await readyArt(page, 'current', start);
  await page.locator('.game-portrait-current .game-portrait-switch').click();
  await page.waitForFunction(() => document.querySelector('.game-portrait-current .game-art-front-enter-active'));
  const motion = await page.evaluate(() => {
    const front = document.querySelector('.game-portrait-current .game-art-front-enter-active');
    const back = document.querySelector('.game-portrait-current .game-art-back-enter-active');
    const animations = [front, back].flatMap(element => element.getAnimations());
    animations.forEach(animation => { animation.pause(); animation.currentTime = 100; });
    const result = { frontX: new DOMMatrix(getComputedStyle(front).transform).m41, backX: new DOMMatrix(getComputedStyle(back).transform).m41, durations: animations.map(animation => animation.effect.getTiming().duration) };
    animations.forEach(animation => animation.finish());
    return result;
  });
  assert.ok(motion.frontX < 0 && motion.backX > 0, JSON.stringify(motion));
  assert.ok(motion.durations.every(duration => duration === 300));
  await readyPhase(page, 'current', start, 'elite2');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.game-portrait-current .game-portrait-switch').click();
  await readyPhase(page, 'current', start, 'base');
  assert.equal(await page.locator('.game-portrait-current .game-portrait-foreground').evaluate(element => element.getAnimations().length), 0);
  await page.close();
});

await check('varied operator compositions remain contained in both phases', async () => {
  const page = await makePage({ width: 1920, height: 1000 });
  for (const [name, from, to] of [
    ['haruka-exusiai', 'char_4202_haruka', 'char_103_angel'],
    ['shu-phantom', 'char_2025_shu', 'char_250_phatom'],
    ['arene-degenbrecher', 'char_271_spikes', 'char_4116_blkkgt'],
  ]) {
    await seed(page, from, to); await readyArt(page, 'current', from); await readyArt(page, 'target', to);
    await screenshot(page, `${name}-base`);
    for (const side of ['current', 'target']) await page.locator(`.game-portrait-${side} .game-portrait-switch`).click();
    await readyPhase(page, 'current', from, 'elite2'); await readyPhase(page, 'target', to, 'elite2');
    await screenshot(page, `${name}-elite2`);
    await noOverflow(page);
  }
  await page.close();
});

await browser.close();
assert.deepEqual(errors, []);
await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ checks, errors }, null, 2) + '\n');
assert.ok(checks.every(check => check.pass), 'Illustration browser verification failed');
