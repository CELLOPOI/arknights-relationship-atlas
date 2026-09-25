import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRACTICE_RECORD_LIMIT, readPracticeRecords, buildPersonalRanking, choosePracticePair, practiceScopes } from './personal-ranking.ts';

const person = (id, kind = 'operator', eligible = true) => ({
  id, name: id.toUpperCase(), kind, eligible, aliases: [], form_ids: [], representative_url: `/${id}.webp`,
});
const people = [person('a'), person('b'), person('c'), person('n', 'npc'), person('m', 'npc'), person('removed', 'operator', false)];
const record = (id, left = 'a', right = 'b', winner = left, outcome = 'choose') => ({
  id, left_id: left, right_id: right, winner_id: winner, outcome, accepted_at: '2026-09-25T01:00:00.000Z',
});
const byId = result => new Map(result.rows.map(row => [row.person.id, row]));

test('BT orders a preference chain and accounts for opponents beyond raw win rate', () => {
  const result = buildPersonalRanking([record('ab'), record('bc', 'b', 'c')], people);
  assert.equal(result.comparisons, 2);
  assert.deepEqual(result.rows.map(row => [row.person.id, row.rank]), [['a', 1], ['b', 2], ['c', 3]]);
  const extra = [...people, person('d'), person('e'), person('f')];
  // a and b each win one of two comparisons, but a faces the stronger opponent c.
  const records = [record('ad', 'a', 'd'), record('ca', 'c', 'a'), record('bf', 'b', 'f'),
    record('db', 'd', 'b'), record('ce', 'c', 'e'), record('ef', 'e', 'f')];
  const rows = byId(buildPersonalRanking(records, extra));
  assert.equal(rows.get('a').wins, rows.get('b').wins);
  assert.equal(rows.get('a').comparisons, rows.get('b').comparisons);
  assert.ok(rows.get('a').score > rows.get('b').score);
  assert.ok([...rows.values()].every(row => Number.isFinite(row.score) && row.score > 0 && row.score < 100));
});

test('symmetric cycles and ties produce honest tied ranks with stable ordering', () => {
  const cycle = buildPersonalRanking([record('ab'), record('bc', 'b', 'c'), record('ca', 'c', 'a')], people);
  assert.deepEqual(cycle.rows.map(row => [row.person.id, row.rank]), [['a', 1], ['b', 1], ['c', 1]]);
  assert.ok(cycle.rows.every(row => Math.abs(row.score - 50) < 1e-6));
  const tied = buildPersonalRanking([record('tie', 'a', 'b', null, 'tie')], people);
  assert.deepEqual(tied.rows.map(row => [row.person.id, row.wins, row.ties, row.comparisons, row.rank]), [
    ['a', 0, 1, 1, 1], ['b', 0, 1, 1, 1],
  ]);
  const sameWinners = buildPersonalRanking([record('ab'), record('cb', 'c', 'b')], people);
  assert.deepEqual(sameWinners.rows.map(row => [row.person.id, row.rank]), [['a', 1], ['c', 1], ['b', 3]]);
});

test('a 500-opponent undefeated record has a finite, converged regularized solution', () => {
  const persons = Array.from({ length: 501 }, (_, index) => person(`p${index}`));
  const records = persons.slice(1).map(other => record(`vs-${other.id}`, 'p0', other.id));
  const result = buildPersonalRanking(records, persons);
  assert.equal(result.comparisons, 500);
  assert.equal(result.rows[0].person.id, 'p0');
  assert.ok(result.rows.every(row => Number.isFinite(row.score) && row.score > 0 && row.score < 100));
  // 检查目标的一阶最优条件，防止仅给出有序但未收敛的数值。
  const ability = new Map(result.rows.map(row => [row.person.id, Math.log(row.score / (100 - row.score))]));
  const gradients = new Map(ability);
  for (const row of records) {
    const error = 1 / (1 + Math.exp(-(ability.get(row.left_id) - ability.get(row.right_id)))) - 1;
    gradients.set(row.left_id, gradients.get(row.left_id) + error);
    gradients.set(row.right_id, gradients.get(row.right_id) - error);
  }
  assert.ok([...gradients.values()].every(value => Math.abs(value) < 1e-5));
  assert.ok(result.rows.slice(1).every(row => row.rank === 2));
});

test('disconnected comparisons are ranked only inside their own groups', () => {
  const result = buildPersonalRanking([record('ab'), record('nm', 'n', 'm')], people, 'all');
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(group => group.rows.map(row => row.rank)), [[1, 2], [1, 2]]);
  assert.deepEqual(result.rows, result.groups.flatMap(group => group.rows));
  assert.ok(!byId(result).has('c'));
});

test('latest explicit pair judgment replaces earlier forms but later skips do not erase it', () => {
  const old = { ...record('old'), accepted_at: '2026-09-20T00:00:00.000Z' };
  delete old.outcome;
  const latest = { ...record('latest', 'b', 'a', 'b'), left: { ...people[1], id: 'form:two', person_id: 'b', form_id: 'two' } };
  const skip = { ...record('skip', 'a', 'b', null, 'skip'), accepted_at: '2026-09-26T00:00:00.000Z' };
  const records = [old, latest, skip];
  const result = buildPersonalRanking(records, people);
  assert.equal(result.comparisons, 1);
  assert.equal(result.rows[0].person.id, 'b');
  assert.equal(byId(result).get('a').comparisons, 1);
  assert.deepEqual(buildPersonalRanking([...records].reverse(), people), result);
  const sameTime = buildPersonalRanking([record('a'), record('z', 'a', 'b', 'b')], people);
  assert.equal(sameTime.rows[0].person.id, 'b');
});

test('default scope includes only operators and all scope filters both eligible endpoints', () => {
  assert.deepEqual(practiceScopes, [{ value: 'operator', label: '仅干员' }, { value: 'all', label: '干员 + NPC' }]);
  const records = [record('operators'), record('npcs', 'n', 'm'), record('mixed', 'a', 'n'),
    record('removed', 'a', 'removed'), record('missing', 'a', 'missing')];
  assert.equal(buildPersonalRanking(records, people, 'all').comparisons, 3);
  const operators = buildPersonalRanking(records, people);
  assert.equal(operators.comparisons, 1);
  assert.deepEqual(operators.rows.map(row => row.person.id), ['a', 'b']);
});

test('invalid judgments, duplicates and unfamiliar answers cannot inflate evidence', () => {
  const good = record('good');
  const records = [good, { ...good }, record('self', 'a', 'a'), record('outsider', 'a', 'b', 'c'),
    record('empty-choice', 'a', 'b', null), record('unknown-outcome', 'a', 'b', 'a', 'unknown'),
    ...['skip', 'unfamiliar', 'unfamiliar_left', 'unfamiliar_right', 'unfamiliar_both'].map(outcome => record(outcome, 'a', 'c', null, outcome))];
  const result = buildPersonalRanking(records, people);
  assert.equal(result.comparisons, 1);
  assert.equal(byId(result).get('a').wins, 1);
  assert.deepEqual(buildPersonalRanking([], people), { rows: [], comparisons: 0, groups: [] });
});

test('pair selection respects operator default and handles too few candidates', () => {
  assert.equal(choosePracticePair([], []), null);
  assert.equal(choosePracticePair([people[0], people[3], people[5]], []), null);
  const pair = choosePracticePair(people, [], 'operator', () => .5);
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0].id, pair[1].id);
  assert.ok(pair.every(person => person.kind === 'operator' && person.eligible));
  assert.ok(choosePracticePair([people[3], people[4]], [], 'all'));
});

test('pair selection first connects existing disconnected groups', () => {
  const extra = [...people, person('d')];
  const records = [record('ab'), record('cd', 'c', 'd')];
  const pair = choosePracticePair(extra, records, 'operator', () => .9).map(person => person.id);
  assert.equal(pair.filter(id => ['a', 'b'].includes(id)).length, 1);
  assert.equal(pair.filter(id => ['c', 'd'].includes(id)).length, 1);
});

test('pair selection mixes introducing new people and missing comparisons among known people', () => {
  const extra = [...people, person('d')];
  const records = [record('ab'), record('bc', 'b', 'c')];
  const introduce = choosePracticePair(extra, records, 'operator', () => .1).map(person => person.id);
  assert.ok(introduce.includes('d'));
  assert.equal(introduce.filter(id => ['a', 'b', 'c'].includes(id)).length, 1);
  const refine = choosePracticePair(extra, records, 'operator', () => .9).map(person => person.id).sort();
  assert.deepEqual(refine, ['a', 'c']);
});

test('pair selection avoids immediate repeat and unfamiliar people when alternatives exist', () => {
  const records = [record('unfamiliar', 'a', 'b', null, 'unfamiliar_left')];
  assert.deepEqual(choosePracticePair(people, records, 'operator', () => .5).map(person => person.id).sort(), ['b', 'c']);
  const onlyTwo = people.slice(0, 2);
  assert.deepEqual(choosePracticePair(onlyTwo, records, 'operator', () => .5).map(person => person.id).sort(), ['a', 'b']);
});

test('storage reader tolerates corrupt containers and drops invalid records individually', () => {
  for (const raw of [null, '', '{', 'null', '{}', '42']) assert.deepEqual(readPracticeRecords(raw), []);
  const valid = record('valid');
  const invalid = [null, {}, { ...valid, id: '' }, { ...valid, id: 3 },
    { ...valid, id: 'bad-right', right_id: null }, { ...valid, id: 'bad-winner', winner_id: 'c' },
    { ...valid, id: 'bad-date', accepted_at: 'not a date' }];
  const restored = readPracticeRecords(JSON.stringify([...invalid, valid]));
  assert.deepEqual(restored.map(row => row.id), ['valid']);
  assert.equal(restored[0].winner_id, 'a');
  assert.equal(restored[0].outcome, 'choose');
});

test('storage retains outcome semantics and legacy records even with unusable display snapshots', () => {
  const legacy = { ...record('legacy'), left: 42, right: { name: null } };
  delete legacy.outcome;
  const records = [legacy, record('tie', 'a', 'b', null, 'tie'), record('skip', 'a', 'b', null, 'skip'),
    record('unfamiliar', 'a', 'b', null, 'unfamiliar_left')];
  const restored = readPracticeRecords(JSON.stringify(records));
  assert.deepEqual(restored.map(row => row.id), records.map(row => row.id));
  assert.deepEqual(restored.slice(1).map(row => row.outcome), ['tie', 'skip', 'unfamiliar_left']);
  assert.equal(buildPersonalRanking(restored, people).comparisons, 1);
});

test('storage deduplicates before retaining the most recent 500 entries in stored order', () => {
  assert.equal(PRACTICE_RECORD_LIMIT, 500);
  const records = Array.from({ length: 502 }, (_, index) => record(`r${index}`));
  records[0].accepted_at = '2020-01-01T00:00:00.000Z';
  const restored = readPracticeRecords(JSON.stringify([records[0], records[0], ...records.slice(1)]));
  assert.equal(restored.length, 500);
  assert.equal(restored[0].id, 'r0');
  assert.equal(restored.at(-1).id, 'r499');
  assert.equal(new Set(restored.map(row => row.id)).size, 500);
});
