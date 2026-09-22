import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, buildNetwork, dataFingerprint, newRound, readRules, validPath } from './network.ts';
import { canFillGap, completionPath, completionWon, excludedCandidate, fillGap, newCompletionRound, resetCompletion, restoreCompletion } from './completion.ts';
import { createSession, modeRules, readGameSave } from './modes.ts';
import { matchNames, normalizeName, uniqueExactMatch } from './names.ts';
import { gameGraph } from '../../../scripts/game-ui-fixture.mjs';

const rules = { scope: 'all', difficulty: 'easy', bannedIds: [] };
function graph(ids, edges) {
  return { nodes: ids.map(id => ({ id, name: id, aliases: [], factionId: 'test', factionName: 'Test' })),
    edges: edges.map(([source, target]) => ({ id: `${source}|${target}`, source, target, kind: 'awareness' })) };
}
const data = graph(['a', 'b', 'c', 'alternate', 'decoy'], [['a', 'b'], ['b', 'c'], ['a', 'alternate'], ['alternate', 'c'], ['a', 'decoy']]);
const network = buildNetwork(data, rules);
const puzzle = { startId: 'a', targetId: 'c', shortestPath: ['a', 'b', 'c'] };

test('completion accepts alternate bridges and never fills a one-sided or unrelated choice', () => {
  let round = newCompletionRound(network, puzzle, 'easy', () => .5);
  assert.equal(canFillGap(network, round, 1, 'decoy'), false);
  assert.equal(excludedCandidate(network, round), 'decoy');
  round = fillGap(network, round, 'decoy');
  assert.equal(round.attempts, 1);
  assert.deepEqual(completionPath(round), ['a', null, 'c']);
  assert.equal(fillGap(network, round, 'missing'), null);
  assert.equal(canFillGap(network, round, 1, 'alternate'), true);
  round = fillGap(network, round, 'alternate');
  assert.equal(completionWon(round), true);
  assert.deepEqual(completionPath(round), ['a', 'alternate', 'c']);
  assert.equal(fillGap(network, round, 'b'), null);
  assert.deepEqual(restoreCompletion(round, network, 'easy'), round);
  const reset = resetCompletion(round);
  assert.equal(reset.attempts, 0);
  assert.equal(completionWon(reset), false);
  assert.equal(fillGap(network, { ...reset, revealed: true }, 'b'), null);
});

test('one, two and three gaps keep visible anchors, allow out-of-order answers and remain solvable', () => {
  const data = graph(['0', '1', '2', '3', '4', '5', '6', 'x', 'y', 'z'], [['0', '1'], ['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['5', '6'], ['0', 'x'], ['x', '2'], ['2', 'y'], ['y', '4'], ['4', 'z'], ['z', '6']]);
  const net = buildNetwork(data, rules);
  for (const [difficulty, expectedGaps] of [['easy', [1]], ['normal', [1, 3]], ['hard', [1, 3, 5]]]) {
    const path = ['0', '1', '2', '3', '4', '5', '6'].slice(0, expectedGaps.length * 2 + 1);
    const question = { startId: '0', targetId: path.at(-1), shortestPath: path };
    let round = newCompletionRound(net, question, difficulty, () => .5);
    assert.deepEqual(round.gaps, expectedGaps);
    assert.equal(new Set(Object.values(round.options).flat()).size, Object.values(round.options).flat().length);
    for (const index of [...round.gaps].reverse()) {
      assert.ok(completionPath(round)[index - 1]);
      assert.ok(completionPath(round)[index + 1]);
      round = { ...round, activeGap: index };
      const answer = round.options[index].find(id => canFillGap(net, round, index, id));
      round = fillGap(net, round, answer);
      assert.deepEqual(restoreCompletion(round, net, difficulty), round);
    }
    assert.equal(completionWon(round), true);
    assert.ok(validPath(net, completionPath(round)));
  }
});

test('completion rejects obsolete gap counts and never downgrades a restrictive question', () => {
  const data = graph(['0', '1', '2', '3', '4', '5', '6'], [['0', '1'], ['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['5', '6']]);
  const net = buildNetwork(data, rules);
  for (const difficulty of ['normal', 'hard']) {
    const session = createSession(net, { ...rules, difficulty }, 'completion');
    const original = session.completion;
    const stale = { ...original, gaps: original.gaps.slice(0, -1) };
    const saved = readGameSave({ fingerprint: dataFingerprint(data), mode: 'completion', sessions: { completion: { ...session, completion: stale } } }, null, data);
    assert.equal(saved.sessions.completion.completion, null);
    assert.deepEqual(saved.sessions.completion.rules, session.rules);
  }
  const short = buildNetwork(data, { ...rules, bannedIds: ['4', '5', '6'] });
  assert.equal(createSession(short, { ...rules, difficulty: 'normal' }, 'completion'), null);
  assert.ok(createSession(short, { ...rules, difficulty: 'normal' }, 'explore'));
  const tooShort = { startId: '0', targetId: '3', shortestPath: ['0', '1', '2', '3'] };
  assert.throws(() => newCompletionRound(short, tooShort, 'normal'), RangeError);
});

test('completion restoration rejects invalid templates, answers, duplicate choices and changed graph', () => {
  const round = newCompletionRound(network, puzzle, 'easy', () => .5);
  assert.ok(restoreCompletion(round, network, 'easy'));
  assert.equal(restoreCompletion({ ...round, gaps: [0] }, network, 'easy'), null);
  assert.equal(restoreCompletion({ ...round, answers: { 1: 'decoy' }, attempts: 1 }, network, 'easy'), null);
  assert.equal(restoreCompletion({ ...round, answers: { 2: 'b' } }, network, 'easy'), null);
  assert.equal(restoreCompletion({ ...round, options: { 1: ['b', 'b'] } }, network, 'easy'), null);
  assert.equal(restoreCompletion({ ...round, puzzle: { ...puzzle, shortestPath: ['a', 'decoy', 'c'] } }, network, 'easy'), null);
  assert.equal(restoreCompletion(round, buildNetwork(data, { ...rules, bannedIds: ['b'] }), 'easy'), null);
  assert.equal(restoreCompletion({ ...round, activeGap: 2 }, network, 'easy'), null);
});

test('name matching handles true names, nicknames, variants, punctuation, accents and small typos', () => {
  const people = [
    { id: 'goat', name: '艾雅法拉', aliases: ['阿黛尔·瑙曼', 'Eyjafjalla the Hvít Aska', '纯烬艾雅法拉'] },
    { id: 'chen', name: '陈', aliases: ["Ch'en", '陈晖洁', '假日威龙陈'] },
    { id: 'surtr', name: '史尔特尔', aliases: ['Surtr'] },
  ];
  assert.equal(normalizeName(' ＣＨ’ＥＮ '), 'chen');
  for (const query of ['小羊', '阿黛尔·瑙曼', '纯烬艾雅法拉', 'Eyjafjalla the Hvit Aska']) assert.equal(uniqueExactMatch(matchNames(people, query))?.id, 'goat');
  for (const query of ['水陈', 'CHEN', '陈晖洁']) assert.equal(uniqueExactMatch(matchNames(people, query))?.id, 'chen');
  assert.equal(uniqueExactMatch(matchNames(people, '４２'))?.id, 'surtr');
  for (const query of ['阿黛尔', '艾法拉', '艾雅法啦']) {
    assert.equal(matchNames(people, query)[0]?.person.id, 'goat');
    assert.equal(uniqueExactMatch(matchNames(people, query)), null);
  }
  assert.deepEqual(matchNames(people, '   '), []);
  assert.deepEqual(matchNames(people, 'no-such-person-9284'), []);
});

test('ambiguous aliases are never auto-selected, and matching does not depend on adjacency', () => {
  const people = [{ id: 'a', name: '甲', aliases: ['同名', 'Alpha'] }, { id: 'b', name: '乙', aliases: ['同名', 'Alpine'] }];
  assert.equal(matchNames(people, '同名').length, 2);
  assert.equal(uniqueExactMatch(matchNames(people, '同名')), null);
  assert.equal(uniqueExactMatch(matchNames(people, 'Alp')), null);
  assert.equal(matchNames(data.nodes, 'decoy')[0].person.id, 'decoy');
});

test('mode save migrates legacy exploration and isolates completion and input progress', () => {
  const fingerprint = dataFingerprint(data);
  const legacy = { fingerprint, rules, round: advance(network, newRound(puzzle), 'b') };
  const migrated = readGameSave(null, legacy, data);
  assert.equal(migrated.mode, 'explore');
  assert.deepEqual(migrated.sessions.explore.round.path, ['a', 'b']);
  const completion = newCompletionRound(network, puzzle, 'easy', () => .5);
  const sessions = { ...migrated.sessions, completion: { rules, completion, round: null }, input: { rules, round: newRound(puzzle), completion: null } };
  const saved = readGameSave({ fingerprint, mode: 'input', sessions }, null, data);
  assert.equal(saved.mode, 'input');
  assert.deepEqual(saved.sessions.explore.round.path, ['a', 'b']);
  assert.deepEqual(saved.sessions.input.round.path, ['a']);
  assert.deepEqual(saved.sessions.completion.completion, completion);
  const stale = readGameSave({ fingerprint: 'stale', mode: 'input', sessions }, null, data);
  for (const session of Object.values(stale.sessions)) {
    assert.equal(session.round, null); assert.equal(session.completion, null); assert.deepEqual(session.rules, rules);
  }
  assert.equal(readGameSave({ mode: '__proto__', sessions: {} }, null, data).mode, 'completion');
  assert.equal(readGameSave(null, null, data).mode, 'completion');
});

test('all modes default to operators while explicit saved scope choices are preserved', () => {
  for (const mode of ['completion', 'explore', 'input', 'recognition']) assert.equal(modeRules(mode).scope, 'operators');
  assert.equal(readRules(null, data).scope, 'operators');
  assert.equal(readRules({}, data).scope, 'operators');
  assert.equal(readRules({ scope: 'invalid' }, data).scope, 'operators');
  assert.equal(readRules({ scope: 'all' }, data).scope, 'all');
});

test('real operator-only and full graphs provide solvable puzzles for every mode and difficulty', () => {
  const people = new Map(gameGraph.nodes.map(person => [person.id, person]));
  for (const scope of ['operators', 'all']) for (const mode of ['completion', 'explore', 'input']) for (const [difficulty, gaps] of [['easy', 1], ['normal', 2], ['hard', 3]]) {
    const rules = { ...modeRules(mode), scope, difficulty };
    const net = buildNetwork(gameGraph, rules);
    const session = createSession(net, rules, mode);
    assert.ok(session, `${scope}/${mode}/${difficulty}`);
    const question = session.round?.puzzle || session.completion.puzzle;
    assert.ok(validPath(net, question.shortestPath));
    if (scope === 'operators') assert.ok(question.shortestPath.every(id => people.get(id).isOperator));
    if (mode === 'completion') {
      let round = session.completion;
      assert.equal(round.gaps.length, gaps);
      assert.equal(question.shortestPath.length, gaps * 2 + 1);
      if (scope === 'operators') assert.ok(Object.values(round.options).flat().every(id => people.get(id).isOperator));
      assert.ok(restoreCompletion(round, net, difficulty));
      for (const index of round.gaps) round = fillGap(net, round, question.shortestPath[index]);
      assert.equal(completionWon(round), true);
    } else {
      let round = session.round;
      for (const id of question.shortestPath.slice(1)) round = advance(net, round, id);
      assert.equal(round.path.at(-1), question.targetId);
    }
  }
});
