import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork, validPath } from './network.ts';
import { newCompletionRound } from './completion.ts';
import { completionSolutions, findSolutions } from './solutions.ts';

const data = {
  nodes: ['a', 'b', 'c', 'd', 'e', 't'].map(id => ({ id, name: id, aliases: [], factionId: '', factionName: '', isOperator: id !== 'e' })),
  edges: [['a', 'b'], ['b', 't'], ['a', 'c'], ['c', 't'], ['b', 'd'], ['d', 't'], ['a', 'e'], ['e', 't']].map(([source, target]) => ({ id: `${source}|${target}`, source, target, kind: 'mutual' })),
};

test('answer expansion lists distinct valid routes in step order and honors scope and bans', () => {
  const net = buildNetwork(data, { scope: 'operators', difficulty: 'easy', bannedIds: ['c'] });
  const result = findSolutions(net, 'a', 't');
  assert.deepEqual(result.paths, [['a', 'b', 't'], ['a', 'b', 'd', 't']]);
  assert.equal(result.limited, false);
  assert.ok(result.paths.every(path => validPath(net, path) && !path.includes('c') && !path.includes('e')));
  assert.deepEqual(findSolutions(net, 'a', 'missing'), { paths: [], limited: false });
  const all = buildNetwork(data, { scope: 'all', difficulty: 'easy', bannedIds: [] });
  const limited = findSolutions(all, 'a', 't', 2);
  assert.equal(limited.paths.length, 2);
  assert.equal(limited.limited, true);
  assert.equal(new Set(limited.paths.map(path => path.join('>'))).size, 2);
});

test('ordinary answer expansion preserves visible anchors and offered candidate constraints', () => {
  const net = buildNetwork(data, { scope: 'all', difficulty: 'easy', bannedIds: [] });
  const round = newCompletionRound(net, { startId: 'a', targetId: 't', shortestPath: ['a', 'b', 't'] }, 'easy', () => .5);
  const result = completionSolutions(net, round);
  assert.ok(result.paths.length > 1);
  for (const path of result.paths) {
    assert.ok(validPath(net, path));
    assert.equal(path.length, 3);
    assert.equal(path[0], 'a'); assert.equal(path[2], 't');
    assert.ok(round.options[1].includes(path[1]));
  }
  assert.equal(completionSolutions(net, { ...round, options: { 1: ['b'] } }).paths.length, 1);
});
