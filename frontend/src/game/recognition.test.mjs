import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork, dataFingerprint } from './network.ts';
import { createSession, modeRules, readGameSave } from './modes.ts';
import { answerRecognition, answerRecognitionBridge, isRecognitionBridge, knowsEachOther, newRecognitionRound, nextRecognition, recognitionQuestionComplete, recognitionScore, restoreRecognition } from './recognition.ts';
import { gameGraph } from '../../../scripts/game-ui-fixture.mjs';

const rules = { scope: 'all', difficulty: 'easy', bannedIds: [] };
function graph(size, edges) {
  return { nodes: Array.from({ length: size }, (_, index) => ({ id: String(index), name: String(index), aliases: [], factionId: 'test', factionName: 'Test' })),
    edges: edges.map(([source, target]) => ({ id: `${source}|${target}`, source: String(source), target: String(target), kind: 'awareness' })) };
}
const data = graph(14, Array.from({ length: 13 }, (_, index) => [index, index + 1]));
const network = buildNetwork(data, rules);
const key = pair => [pair.leftId, pair.rightId].sort().join('|');
function random(seed = 42) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('recognition means one direct edge of any kind in either direction, never a multi-step path', () => {
  assert.equal(knowsEachOther(network, { leftId: '0', rightId: '1' }), true);
  assert.equal(knowsEachOther(network, { leftId: '1', rightId: '0' }), true);
  assert.equal(knowsEachOther(network, { leftId: '0', rightId: '2' }), false);
});

test('each shuffled batch has five connected and five unconnected unique canonical pairs', () => {
  const firstPairs = new Set();
  for (let seed = 1; seed <= 32; seed++) {
    const round = newRecognitionRound(network, null, random(seed));
    assert.equal(round.questions.length, 10);
    assert.equal(round.questions.filter(pair => knowsEachOther(network, pair)).length, 5);
    assert.equal(new Set(round.questions.map(key)).size, 10);
    assert.ok(round.questions.every(pair => pair.leftId !== pair.rightId));
    for (const pair of round.questions) {
      if (knowsEachOther(network, pair)) assert.deepEqual(pair.options, []);
      else {
        assert.equal(pair.options.length, 6);
        assert.ok(pair.options.some(id => isRecognitionBridge(network, pair, id)));
        assert.ok(pair.options.some(id => !isRecognitionBridge(network, pair, id)));
        assert.equal(new Set(pair.options).size, pair.options.length);
      }
    }
    assert.deepEqual(restoreRecognition(round, network), round);
    firstPairs.add(key(round.questions[0]));
  }
  assert.ok(firstPairs.size > 1);
  const previous = newRecognitionRound(network, null, random());
  const previousPairs = new Set(previous.questions.map(key));
  const next = newRecognitionRound(network, previous, random(89));
  assert.ok(next.questions.every(pair => !previousPairs.has(key(pair))));
});

test('small pools fail explicitly instead of changing the ratio, repeating within a batch or looping', () => {
  const onlyConnected = buildNetwork(graph(4, [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]), rules);
  for (const net of [onlyConnected, buildNetwork(graph(10, []), rules), buildNetwork(graph(0, []), rules)]) {
    assert.equal(newRecognitionRound(net), null);
  }
  const exact = buildNetwork(graph(6, [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]), rules);
  const previous = newRecognitionRound(exact, null, random());
  assert.ok(newRecognitionRound(exact, previous, random(9)));
});

test('answers lock once, advance only after submission and score against the graph', () => {
  let round = newRecognitionRound(network, null, random());
  for (let index = 0; index < 10; index++) {
    assert.equal(round.index, index);
    assert.equal(nextRecognition(round), null);
    const answer = knowsEachOther(network, round.questions[index]);
    round = answerRecognition(round, index % 2 === 0 ? answer : !answer);
    assert.equal(answerRecognition(round, answer), null);
    if (!answer) {
      assert.equal(nextRecognition(round), null);
      assert.equal(recognitionQuestionComplete(round), false);
      assert.deepEqual(restoreRecognition(round, network), round);
      assert.equal(answerRecognitionBridge(network, round, 'not-in-pool'), null);
      const bridge = round.questions[index].options.find(id => isRecognitionBridge(network, round.questions[index], id));
      round = answerRecognitionBridge(network, round, bridge);
      assert.equal(answerRecognitionBridge(network, round, bridge), null);
    }
    assert.deepEqual(restoreRecognition(round, network), round);
    assert.equal(recognitionScore(network, round), Math.ceil((index + 1) / 2));
    if (index < 9) round = nextRecognition(round);
  }
  assert.equal(nextRecognition(round), null);
  assert.equal(recognitionScore(network, round), 5);
});

test('unconnected questions always have a one-person solution and accept any valid offered intermediary', () => {
  const rules = modeRules('recognition');
  const net = buildNetwork(gameGraph, rules);
  const round = newRecognitionRound(net, null, random());
  for (const [index, pair] of round.questions.entries()) {
    if (knowsEachOther(net, pair)) continue;
    const valid = pair.options.filter(id => isRecognitionBridge(net, pair, id));
    assert.ok(valid.length >= 1 && valid.length <= 2);
    assert.equal(pair.options.length, 6);
    const current = { questions: [pair], answers: [], index: 0 };
    for (const id of valid) {
      const submitted = answerRecognitionBridge(net, answerRecognition(current, false), id);
      assert.equal(recognitionScore(net, submitted), 1);
      assert.equal(recognitionQuestionComplete(submitted), true);
    }
    const decoy = pair.options.find(id => !isRecognitionBridge(net, pair, id));
    const wrong = answerRecognitionBridge(net, answerRecognition(current, false), decoy);
    assert.equal(recognitionScore(net, wrong), 0);
    assert.equal(recognitionQuestionComplete(wrong), true);
  }
});

test('restoration rejects corrupted, out-of-scope and obsolete pair batches', () => {
  const round = newRecognitionRound(network, null, random());
  const first = round.questions[0];
  for (const value of [null, {}, { ...round, index: -1 }, { ...round, index: 10 }, { ...round, answers: [true, false] },
    { ...round, answers: ['true'] }, { ...round, questions: round.questions.slice(1) },
    { ...round, questions: [{ leftId: first.rightId, rightId: first.leftId }, ...round.questions.slice(0, 9)] },
    { ...round, questions: [null, ...round.questions.slice(1)] },
    { ...round, questions: [{ leftId: first.leftId, rightId: first.leftId }, ...round.questions.slice(1)] }]) {
    assert.equal(restoreRecognition(value, network), null);
  }
  assert.equal(restoreRecognition(round, buildNetwork(data, { ...rules, bannedIds: [first.leftId] })), null);
  assert.equal(restoreRecognition(round, buildNetwork({ ...data, edges: [] }, rules)), null);
  const index = round.questions.findIndex(pair => !knowsEachOther(network, pair));
  const questions = [...round.questions];
  const pair = questions[index];
  questions[index] = { ...pair, options: pair.options.filter(id => !isRecognitionBridge(network, pair, id)) };
  assert.equal(restoreRecognition({ ...round, questions }, network), null);
  questions[index] = { ...pair, options: [pair.leftId] };
  assert.equal(restoreRecognition({ ...round, questions }, network), null);
  const firstUnconnected = { ...round, questions: [pair, ...round.questions.filter((_, position) => position !== index)] };
  const pending = answerRecognition(firstUnconnected, false);
  assert.equal(restoreRecognition({ ...pending, index: 1 }, network), null);
  assert.equal(restoreRecognition({ ...pending, answers: [{ knows: false, bridgeId: 'missing' }] }, network), null);
});

test('recognition uses the actual filtered pool and restores independently alongside existing modes', () => {
  for (const scope of ['operators', 'all']) {
    const rules = { ...modeRules('recognition'), scope };
    const net = buildNetwork(gameGraph, rules);
    const session = createSession(net, rules, 'recognition');
    assert.ok(session.recognition);
    assert.equal(session.round, null);
    assert.equal(session.completion, null);
    for (const pair of session.recognition.questions) for (const id of [pair.leftId, pair.rightId]) {
      assert.equal(rules.bannedIds.includes(id), false);
      assert.ok(net.people.has(id));
      if (scope === 'operators') assert.equal(net.people.get(id).isOperator, true);
    }
    assert.ok(session.recognition.questions.flatMap(pair => pair.options).every(id => net.people.has(id)));
    session.recognition = answerRecognition(session.recognition, false);
    const completionRules = modeRules('completion');
    const completion = createSession(buildNetwork(gameGraph, completionRules), completionRules, 'completion');
    const saved = { fingerprint: dataFingerprint(gameGraph), mode: 'recognition', sessions: { recognition: session, completion } };
    const restored = readGameSave(saved, null, gameGraph);
    assert.equal(restored.mode, 'recognition');
    assert.deepEqual(restored.sessions.recognition.recognition, session.recognition);
    assert.deepEqual(restored.sessions.recognition.appearances, session.appearances);
    assert.deepEqual(restored.sessions.completion.completion, completion.completion);
    assert.equal(readGameSave({ ...saved, fingerprint: 'obsolete' }, null, gameGraph).sessions.recognition.recognition, null);
  }
});
