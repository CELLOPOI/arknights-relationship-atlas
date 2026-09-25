import type { Person, RecordItem } from './types';

export const PRACTICE_RECORD_LIMIT = 500;
export const PRACTICE_STORAGE_KEY = 'terra-preference-practice';
export type PracticeScope = 'operator' | 'all';
export const practiceScopes: { value: PracticeScope; label: string }[] = [
  { value: 'operator', label: '仅干员' }, { value: 'all', label: '干员 + NPC' },
];
const outcomes = new Set(['choose', 'tie', 'skip', 'unfamiliar', 'unfamiliar_left', 'unfamiliar_right', 'unfamiliar_both']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validRecord(value: unknown): value is RecordItem {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.left_id !== 'string' || !value.left_id
    || typeof value.right_id !== 'string' || !value.right_id || value.left_id === value.right_id
    || typeof value.accepted_at !== 'string' || !Number.isFinite(Date.parse(value.accepted_at))) return false;
  if (value.outcome !== undefined && (typeof value.outcome !== 'string' || !outcomes.has(value.outcome))) return false;
  if (value.winner_id !== null && value.winner_id !== value.left_id && value.winner_id !== value.right_id) return false;
  return value.outcome === undefined || (value.outcome === 'choose' ? value.winner_id !== null : value.winner_id === null);
}

export function readPracticeRecords(raw: string | null): RecordItem[] {
  try {
    const data: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data.filter((item): item is RecordItem => {
      if (!validRecord(item) || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    }).slice(0, PRACTICE_RECORD_LIMIT).map(item => {
      // 历史快照只用于显示姓名；损坏快照不影响可核对的人物 ID 和判断。
      const snapshot = (value: unknown) => object(value) && typeof value.id === 'string' && typeof value.name === 'string'
        ? value as unknown as Person : undefined;
      return { id: item.id, left_id: item.left_id, right_id: item.right_id, winner_id: item.winner_id,
        outcome: item.outcome, accepted_at: item.accepted_at, left: snapshot(item.left), right: snapshot(item.right) };
    });
  } catch { return []; }
}

const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort(compareIds));
const eligiblePeople = (persons: Person[], scope: PracticeScope) => new Map(persons
  .filter(person => person.eligible && (scope === 'all' ? ['operator', 'npc'].includes(person.kind) : person.kind === 'operator'))
  .map(person => [person.id, person]));
function orderedRecords(records: RecordItem[]) {
  // 同一时间以稳定 ID 决定先后；冲突的重复 ID 也不依赖输入排列。
  const ordered = records.filter(validRecord).sort((a, b) => Date.parse(b.accepted_at) - Date.parse(a.accepted_at)
    || compareIds(b.id, a.id) || compareIds(JSON.stringify([a.left_id, a.right_id, a.winner_id, a.outcome]), JSON.stringify([b.left_id, b.right_id, b.winner_id, b.outcome])));
  const seen = new Set<string>();
  return ordered.filter(record => { if (seen.has(record.id)) return false; seen.add(record.id); return true; });
}
function judgments(records: RecordItem[], people: Map<string, Person>) {
  const pairs = new Set<string>();
  return orderedRecords(records).filter(record => {
    if (!people.has(record.left_id) || !people.has(record.right_id)
      || !(record.outcome === 'tie' || record.winner_id && (!record.outcome || record.outcome === 'choose'))) return false;
    const key = pairKey(record.left_id, record.right_id);
    if (pairs.has(key)) return false;
    pairs.add(key); return true;
  });
}

export type PersonalRankingRow = { person: Person; wins: number; ties: number; comparisons: number; score: number; rank: number };
export type PersonalRankingGroup = { id: string; rows: PersonalRankingRow[] };

export function buildPersonalRanking(records: RecordItem[], persons: Person[], scope: PracticeScope = 'operator') {
  const people = eligiblePeople(persons, scope);
  const observations = judgments(records, people);
  const totals = new Map<string, { person: Person; wins: number; ties: number; comparisons: number }>();
  const neighbors = new Map<string, Set<string>>();
  for (const record of observations) {
    const tie = record.outcome === 'tie';
    for (const id of [record.left_id, record.right_id]) {
      const row = totals.get(id) || { person: people.get(id)!, wins: 0, ties: 0, comparisons: 0 };
      row.comparisons++;
      if (tie) row.ties++;
      else if (record.winner_id === id) row.wins++;
      totals.set(id, row);
    }
    for (const [id, other] of [[record.left_id, record.right_id], [record.right_id, record.left_id]] as const) {
      if (!neighbors.has(id)) neighbors.set(id, new Set());
      neighbors.get(id)!.add(other);
    }
  }
  const unseen = new Set([...totals.keys()].sort(compareIds));
  const groups: PersonalRankingGroup[] = [];
  while (unseen.size) {
    const first = unseen.values().next().value!;
    const component = new Set<string>(), pending = [first];
    while (pending.length) {
      const id = pending.pop()!;
      if (component.has(id)) continue;
      component.add(id); unseen.delete(id);
      for (const other of neighbors.get(id)!) if (!component.has(other)) pending.push(other);
    }
    const ids = [...component].sort(compareIds);
    const edges = new Map(ids.map(id => [id, [] as { other: string; outcome: number }[]]));
    // 固定边顺序，避免输入重排造成浮点累加与最终并列顺序变化。
    for (const record of observations.filter(record => component.has(record.left_id)).sort((a, b) => compareIds(pairKey(a.left_id, a.right_id), pairKey(b.left_id, b.right_id)))) {
      const outcome = record.outcome === 'tie' ? .5 : record.winner_id === record.left_id ? 1 : 0;
      edges.get(record.left_id)!.push({ other: record.right_id, outcome });
      edges.get(record.right_id)!.push({ other: record.left_id, outcome: 1 - outcome });
    }
    const ability = new Map(ids.map(id => [id, 0]));
    // BT 成对似然 + lambda=1 的对数能力 L2 先验。逐坐标求一维严格凸最优，
    // 二分保证下降，避免牛顿步在全胜、小样本时溢出；每轮成本与有效对位数成正比。
    for (let iteration = 0; iteration < 100; iteration++) {
      let change = 0;
      for (const id of ids) {
        const matches = edges.get(id)!;
        let low = -matches.length, high = matches.length;
        for (let step = 0; step < 36; step++) {
          const value = (low + high) / 2;
          let gradient = value;
          for (const edge of matches) gradient += 1 / (1 + Math.exp(-(value - ability.get(edge.other)!))) - edge.outcome;
          if (gradient > 0) high = value; else low = value;
        }
        const next = (low + high) / 2;
        change = Math.max(change, Math.abs(next - ability.get(id)!));
        ability.set(id, next);
      }
      if (change < 1e-9) break;
    }
    const rows: PersonalRankingRow[] = ids.map(id => ({ ...totals.get(id)!, score: 100 / (1 + Math.exp(-ability.get(id)!)), rank: 0 }));
    rows.sort((a, b) => b.score - a.score || compareIds(a.person.id, b.person.id));
    // 对称循环和平局的微小求解误差不应制造虚假名次。
    let start = 0;
    while (start < rows.length) {
      let end = start + 1;
      while (end < rows.length && Math.abs(rows[end]!.score - rows[start]!.score) < 1e-6) end++;
      const tied = rows.slice(start, end).sort((a, b) => compareIds(a.person.id, b.person.id));
      tied.forEach(row => { row.rank = start + 1; });
      rows.splice(start, end - start, ...tied); start = end;
    }
    groups.push({ id: first, rows });
  }
  return { rows: groups.flatMap(group => group.rows), comparisons: observations.length, groups };
}

export function choosePracticePair(persons: Person[], records: RecordItem[], scope: PracticeScope = 'operator', random: () => number = Math.random): [Person, Person] | null {
  const people = eligiblePeople(persons, scope);
  const pool = [...people.values()].sort((a, b) => compareIds(a.id, b.id));
  if (pool.length < 2) return null;
  const ranking = buildPersonalRanking(records, persons, scope);
  const known = new Set(ranking.rows.map(row => row.person.id));
  const scores = new Map(ranking.rows.map(row => [row.person.id, row.score]));
  const groupOf = new Map(ranking.groups.flatMap(group => group.rows.map(row => [row.person.id, group.id] as const)));
  const compared = new Set(judgments(records, people).map(record => pairKey(record.left_id, record.right_id)));
  const recent = orderedRecords(records).filter(record => people.has(record.left_id) && people.has(record.right_id)).slice(0, 8);
  const previous = recent[0] ? pairKey(recent[0].left_id, recent[0].right_id) : '';
  const unfamiliar = new Set<string>();
  for (const record of recent) {
    if (['unfamiliar', 'unfamiliar_both', 'unfamiliar_left'].includes(record.outcome || '')) unfamiliar.add(record.left_id);
    if (['unfamiliar', 'unfamiliar_both', 'unfamiliar_right'].includes(record.outcome || '')) unfamiliar.add(record.right_id);
  }
  // 先桥接已有分组；否则混合引入新人物与补足已有人物对位，避免永远扩展离散小组。
  const introduce = known.size > 0 && known.size < pool.length && random() < .35;
  let best: [Person, Person] | null = null, bestPriority = Infinity, bestPenalty = Infinity, bestDistance = Infinity, ties = 0;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const left = pool[i]!, right = pool[j]!, key = pairKey(left.id, right.id);
    const bothKnown = known.has(left.id) && known.has(right.id);
    const oneNew = known.has(left.id) !== known.has(right.id);
    let priority: number;
    if (!known.size) priority = 0;
    else if (bothKnown && groupOf.get(left.id) !== groupOf.get(right.id)) priority = 0;
    else if (oneNew) priority = introduce ? 1 : 3;
    else if (bothKnown && !compared.has(key)) priority = introduce ? 2 : 1;
    else if (bothKnown) priority = 4;
    else priority = 5;
    // 相同任务类别内软避开最近一题和不熟悉人物，候选不足仍能继续。
    const penalty = (key === previous ? 4 : 0) + Number(unfamiliar.has(left.id)) + Number(unfamiliar.has(right.id));
    const distance = bothKnown && groupOf.get(left.id) === groupOf.get(right.id) ? Math.abs(scores.get(left.id)! - scores.get(right.id)!) : 0;
    const better = priority < bestPriority || priority === bestPriority && (penalty < bestPenalty || penalty === bestPenalty && distance < bestDistance - 1e-6);
    const equal = priority === bestPriority && penalty === bestPenalty && Math.abs(distance - bestDistance) < 1e-6;
    if (better) { best = [left, right]; bestPriority = priority; bestPenalty = penalty; bestDistance = distance; ties = 1; }
    else if (equal && random() < 1 / ++ties) best = [left, right];
  }
  return best && random() < .5 ? [best[1], best[0]] : best;
}
