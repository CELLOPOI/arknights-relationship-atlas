import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_BANS, advance, buildNetwork, dataFingerprint, defaultRules, generatePuzzle,
  newRound, nextHint, readRules, restoreRound, shortestPath, validPath,
} from './network.ts';

function graph(ids, connections) {
  return { nodes: ids.map(id => ({ id, name: id, aliases: [], factionId: 'test', factionName: 'Test' })),
    edges: connections.map(([a, b, kind = 'mutual']) => ({ id: [a, b].sort().join('|'), source: a, target: b, kind })) };
}
const rules = { scope: 'all', difficulty: 'normal', bannedIds: [] };

test('every recorded edge, including awareness, is traversable in both directions', () => {
  const network = buildNetwork(graph(['a', 'b', 'c'], [['a', 'b', 'awareness'], ['b', 'c']]), rules);
  assert.deepEqual(shortestPath(network, 'c', 'a'), ['c', 'b', 'a']);
  assert.deepEqual(shortestPath(network, 'a', 'c'), ['a', 'b', 'c']);
});

test('bans remove endpoints and intermediates before recalculating shortest paths', () => {
  const data = graph(['a', 'hub', 'b', 'c', 'd'], [['a', 'hub'], ['hub', 'b'], ['a', 'c'], ['c', 'd'], ['d', 'b']]);
  const network = buildNetwork(data, { ...rules, bannedIds: ['hub'] });
  assert.deepEqual(shortestPath(network, 'a', 'b'), ['a', 'c', 'd', 'b']);
  assert.equal(shortestPath(network, 'hub', 'b'), null);
  assert.equal(shortestPath(network, 'a', 'hub'), null);
  const puzzle = generatePuzzle(network, 'normal', () => .4);
  assert.ok(puzzle);
  assert.ok(!puzzle.shortestPath.includes('hub'));
});

test('generation finds valid questions in disconnected data and returns null for impossible restrictions', () => {
  const data = graph(['a', 'b', 'c', 'isolated'], [['a', 'b'], ['b', 'c']]);
  const network = buildNetwork(data, rules);
  assert.equal(generatePuzzle(network, 'easy', () => .4).shortestPath.length, 3);
  assert.equal(generatePuzzle(network, 'normal'), null);
  assert.equal(generatePuzzle(buildNetwork(data, { ...rules, bannedIds: ['b'] }), 'easy'), null);
  assert.equal(generatePuzzle(buildNetwork(data, { ...rules, bannedIds: data.nodes.map(n => n.id) }), 'easy'), null);
});

test('six edges are allowed, seven are rejected, and operator scope removes NPC routes', () => {
  const ids = Array.from({ length: 8 }, (_, i) => String(i));
  const data = graph(ids, ids.slice(1).map((id, i) => [ids[i], id]));
  const network = buildNetwork(data, rules);
  assert.equal(shortestPath(network, '0', '6').length, 7);
  assert.equal(shortestPath(network, '0', '7'), null);
  data.nodes[3].isOperator = false;
  assert.equal(shortestPath(buildNetwork(data, { ...rules, scope: 'operators' }), '0', '6'), null);
});

test('moves must follow real edges without repeating people, and success accepts alternate routes', () => {
  const network = buildNetwork(graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'd'], ['a', 'c'], ['c', 'd']]), rules);
  let round = newRound({ startId: 'a', targetId: 'd', shortestPath: ['a', 'b', 'd'] });
  assert.equal(advance(network, round, 'd'), null);
  round = advance(network, round, 'c');
  assert.equal(advance(network, round, 'a'), null);
  round = advance(network, round, 'd');
  assert.deepEqual(round.path, ['a', 'c', 'd']);
  assert.equal(advance(network, round, 'b'), null);
});

test('hints avoid visited people and do not offer routes beyond the remaining budget', () => {
  const network = buildNetwork(graph(['a', 'b', 'c', 'd', 'e', 'f', 't'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 't'], ['a', 't']]), rules);
  const round = { ...newRound({ startId: 'a', targetId: 't', shortestPath: ['a', 't'] }), path: ['a', 'b'] };
  assert.equal(nextHint(network, round), 'c');
  const deadEnd = buildNetwork(graph(['a', 'b', 't'], [['a', 'b'], ['a', 't']]), rules);
  assert.equal(nextHint(deadEnd, round), null);
  const longer = buildNetwork(graph(['a', 'b', 'c', 'd', 'e', 'f', 'g', 't'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g'], ['g', 't'], ['a', 't']]), rules);
  assert.equal(nextHint(longer, round), null);
});

test('restore validates saved paths and recalculates answers from the current graph', () => {
  const data = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
  const network = buildNetwork(data, rules);
  const round = newRound({ startId: 'a', targetId: 'd', shortestPath: ['invalid'] });
  round.path = ['a', 'b']; round.moves = 3;
  assert.deepEqual(restoreRound(round, network, 'normal').puzzle.shortestPath, ['a', 'b', 'c', 'd']);
  assert.equal(restoreRound({ ...round, path: ['a', 'd'] }, network, 'normal'), null);
  assert.equal(restoreRound({ ...round, path: ['a', 'b', 'a'] }, network, 'normal'), null);
  assert.equal(restoreRound(round, buildNetwork(data, { ...rules, bannedIds: ['b'] }), 'normal'), null);
  assert.equal(restoreRound(null, network, 'normal'), null);
  assert.equal(restoreRound({ ...round, puzzle: { startId: 'a', targetId: 'b' } }, network, 'easy'), null);
  assert.notEqual(dataFingerprint(data), dataFingerprint({ ...data, edges: data.edges.slice(1) }));
  assert.deepEqual(readRules({ difficulty: '__proto__', bannedIds: ['a', 'a', 'missing'] }, data), { ...rules, scope: 'operators', bannedIds: ['a'] });
});

test('real data supports all difficulty levels with the three default bans', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../../../data/npc/graph.json', import.meta.url), 'utf8'));
  const network = buildNetwork(data, defaultRules());
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const puzzle = generatePuzzle(network, difficulty, () => .37);
    assert.ok(puzzle, difficulty);
    assert.ok(validPath(network, puzzle.shortestPath));
    assert.ok(puzzle.shortestPath.every(id => !DEFAULT_BANS.includes(id)));
    assert.ok(puzzle.shortestPath.length <= 7);
  }
  const allEdges = buildNetwork(data, { ...rules, bannedIds: [] });
  assert.equal([...allEdges.neighbors.values()].reduce((count, neighbors) => count + neighbors.size, 0) / 2, data.edges.length);
});
