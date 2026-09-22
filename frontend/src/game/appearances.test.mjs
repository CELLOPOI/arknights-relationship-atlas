import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCES, appearancesFor, chooseAppearances, presentPerson, restoreAppearances } from './appearances.ts';
import { advance, buildNetwork, defaultRules, newRound, shortestPath } from './network.ts';
import { matchNames, uniqueExactMatch } from './names.ts';
import { createSession, readGameSave } from './modes.ts';
import { dataFingerprint } from './network.ts';
import { gameGraph } from '../../../scripts/game-ui-fixture.mjs';

const texas = gameGraph.nodes.find(person => person.name === '德克萨斯');
const alterId = 'char_1028_texas2';

test('alternate appearances change name and art while retaining the same graph identity', () => {
  assert.equal(APPEARANCES.length, 38);
  const choices = chooseAppearances(gameGraph, () => .99);
  const person = presentPerson(texas, choices[texas.id]);
  assert.equal(person.id, texas.id);
  assert.equal(person.name, '缄默德克萨斯');
  assert.equal(person.appearanceId, alterId);
  assert.equal(person.canonicalName, texas.name);
  assert.equal(person.avatar, `/avatars/${alterId}.webp`);
  assert.equal(presentPerson(person).name, texas.name);
  assert.equal(appearancesFor({ ...texas, aliases: [] }).length, 0);
  assert.deepEqual(restoreAppearances({ [texas.id]: 'char_1013_chen2', missing: alterId }, gameGraph), {});
  assert.deepEqual(restoreAppearances({ [texas.id]: alterId }, gameGraph), { [texas.id]: alterId });
});

test('base names and alternate nicknames resolve to one identity without allowing a repeated person', () => {
  const person = presentPerson(texas, alterId);
  for (const name of ['缄默德克萨斯', '异德', 'Texas the Omertosa']) {
    const match = uniqueExactMatch(matchNames([person], name));
    assert.equal(match.id, texas.id);
    assert.equal(match.appearanceId, alterId);
  }
  assert.equal(uniqueExactMatch(matchNames([person], '德克萨斯')).appearanceId, texas.id);
  const rules = defaultRules();
  const net = buildNetwork(gameGraph, rules);
  const neighbor = [...net.neighbors.get(texas.id).keys()][0];
  const target = [...net.people.keys()].find(id => shortestPath(net, texas.id, id)?.length === 3);
  const round = advance(net, newRound({ startId: texas.id, targetId: target, shortestPath: shortestPath(net, texas.id, target) }), neighbor);
  assert.equal(advance(net, round, person.id), null);
  assert.equal(buildNetwork(gameGraph, { ...rules, bannedIds: [...rules.bannedIds, texas.id] }).people.has(person.id), false);
});

test('mode progress retains chosen appearances across reload and validates stale form mappings', () => {
  const rules = defaultRules();
  const session = createSession(buildNetwork(gameGraph, rules), rules, 'input');
  session.appearances[texas.id] = alterId;
  const save = readGameSave({ fingerprint: dataFingerprint(gameGraph), mode: 'input', sessions: { input: session } }, null, gameGraph);
  assert.deepEqual(save.sessions.input.appearances, session.appearances);
  assert.deepEqual(save.sessions.input.round, session.round);
});
