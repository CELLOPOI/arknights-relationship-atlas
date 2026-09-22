// 游戏通路与资料判定分开：所有已收录连线均可双向通行。规则见 docs/GAME.md。
export const MAX_STEPS = 6;
export const DEFAULT_BANS = ['npc_b99957887950ebfd', 'char_002_amiya', 'char_003_kalts'];

export interface GamePerson {
  id: string;
  name: string;
  aliases: string[];
  factionId: string;
  factionName: string;
  isOperator?: boolean;
  avatar?: string;
  version?: number;
  appearanceId?: string;
  canonicalName?: string;
  canonicalAvatar?: string;
}
export interface GameEdge { id: string; source: string; target: string; kind: string; version?: number }
export interface GameData { nodes: GamePerson[]; edges: GameEdge[] }
export type Difficulty = 'easy' | 'normal' | 'hard';
export interface Rules { scope: 'all' | 'operators'; difficulty: Difficulty; bannedIds: string[] }
export interface Network { people: Map<string, GamePerson>; neighbors: Map<string, Map<string, string>> }
export interface Puzzle { startId: string; targetId: string; shortestPath: string[] }
export interface Round {
  puzzle: Puzzle;
  path: string[];
  moves: number;
  hintedPaths: string[];
  revealed: boolean;
}
export const DIFFICULTIES: Record<Difficulty, { label: string; min: number; max: number }> = {
  easy: { label: '入门', min: 2, max: 2 },
  normal: { label: '标准', min: 3, max: 4 },
  hard: { label: '挑战', min: 5, max: 6 },
};

export function defaultRules(): Rules {
  return { scope: 'operators', difficulty: 'normal', bannedIds: [...DEFAULT_BANS] };
}

export function buildNetwork(data: GameData, rules: Rules): Network {
  const banned = new Set(rules.bannedIds);
  const people = new Map(data.nodes.filter(person => !banned.has(person.id)
    && (rules.scope === 'all' || person.isOperator !== false)).map(person => [person.id, person]));
  const neighbors = new Map([...people.keys()].map(id => [id, new Map<string, string>()]));
  for (const edge of data.edges) {
    if (edge.source === edge.target || !people.has(edge.source) || !people.has(edge.target)) continue;
    neighbors.get(edge.source)!.set(edge.target, edge.id);
    neighbors.get(edge.target)!.set(edge.source, edge.id);
  }
  return { people, neighbors };
}

function search(network: Network, start: string, excluded = new Set<string>(), maxDepth = MAX_STEPS) {
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  if (!network.people.has(start) || excluded.has(start)) return { distances, previous };
  distances.set(start, 0);
  const queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    const depth = distances.get(from)!;
    if (depth >= maxDepth) continue;
    for (const to of network.neighbors.get(from)!.keys()) {
      if (distances.has(to) || excluded.has(to)) continue;
      distances.set(to, depth + 1);
      previous.set(to, from);
      queue.push(to);
    }
  }
  return { distances, previous };
}

export function shortestPath(network: Network, start: string, target: string, excluded = new Set<string>()): string[] | null {
  const { distances, previous } = search(network, start, excluded);
  if (!distances.has(target)) return null;
  const path = [target];
  while (path[0] !== start) path.unshift(previous.get(path[0])!);
  return path;
}

export function generatePuzzle(network: Network, difficulty: Difficulty, random = Math.random, last?: Puzzle,
  distance: { min: number; max: number } = DIFFICULTIES[difficulty]): Puzzle | null {
  const { min, max } = distance;
  const ids = [...network.people.keys()].sort();
  let chosen: [string, string] | null = null;
  let fallback: [string, string] | null = null;
  let candidates = 0;
  // 遍历可达人物对后等概率蓄水池采样，避免限制较多时随机重试误报无解。
  for (const start of ids) {
    const { distances } = search(network, start, new Set(), max);
    for (const [target, distance] of distances) {
      if (start >= target || distance < min || distance > max) continue;
      if (last && ((last.startId === start && last.targetId === target) || (last.startId === target && last.targetId === start))) {
        fallback = [start, target];
        continue;
      }
      candidates++;
      if (random() < 1 / candidates) chosen = [start, target];
    }
  }
  const pair = chosen || fallback;
  if (!pair) return null;
  const [startId, targetId] = random() < .5 ? pair : [pair[1], pair[0]];
  return { startId, targetId, shortestPath: shortestPath(network, startId, targetId)! };
}

export function newRound(puzzle: Puzzle): Round {
  return { puzzle, path: [puzzle.startId], moves: 0, hintedPaths: [], revealed: false };
}

export function validPath(network: Network, path: string[]): boolean {
  return path.length > 0 && path.length <= MAX_STEPS + 1 && new Set(path).size === path.length
    && path.every((id, index) => network.people.has(id) && (!index || network.neighbors.get(path[index - 1])?.has(id)));
}

export function advance(network: Network, round: Round, next: string): Round | null {
  const current = round.path[round.path.length - 1];
  if (round.revealed || current === round.puzzle.targetId || round.path.length > MAX_STEPS
    || round.path.includes(next) || !network.neighbors.get(current)?.has(next)) return null;
  return { ...round, path: [...round.path, next], moves: round.moves + 1 };
}

export function nextHint(network: Network, round: Round): string | null {
  const current = round.path[round.path.length - 1];
  const path = shortestPath(network, current, round.puzzle.targetId, new Set(round.path.slice(0, -1)));
  return path && path.length > 1 && path.length - 1 <= MAX_STEPS - (round.path.length - 1) ? path[1] : null;
}

export function dataFingerprint(data: GameData): string {
  const content = [
    ...data.nodes.map(person => `${person.id}:${person.version ?? 0}:${person.isOperator !== false}`),
    ...data.edges.map(edge => `${edge.id}:${edge.source}:${edge.target}:${edge.version ?? 0}`),
  ].sort().join('\n');
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function readRules(value: unknown, data: GameData): Rules {
  if (!value || typeof value !== 'object') return defaultRules();
  const rules = value as Partial<Rules>;
  const known = new Set(data.nodes.map(person => person.id));
  return {
    scope: rules.scope === 'all' ? 'all' : 'operators',
    difficulty: rules.difficulty && Object.hasOwn(DIFFICULTIES, rules.difficulty) ? rules.difficulty : 'normal',
    bannedIds: Array.isArray(rules.bannedIds) ? [...new Set(rules.bannedIds.filter(id => typeof id === 'string' && known.has(id)))] : [...DEFAULT_BANS],
  };
}

export function restoreRound(value: unknown, network: Network, difficulty: Difficulty): Round | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Partial<Round>;
  if (!saved.puzzle || typeof saved.puzzle.startId !== 'string' || typeof saved.puzzle.targetId !== 'string'
    || !Array.isArray(saved.path) || !saved.path.every(id => typeof id === 'string')
    || !validPath(network, saved.path) || saved.path[0] !== saved.puzzle.startId
    || saved.path.slice(0, -1).includes(saved.puzzle.targetId)) return null;
  const path = shortestPath(network, saved.puzzle.startId, saved.puzzle.targetId);
  const { min, max } = DIFFICULTIES[difficulty];
  if (!path || path.length - 1 < min || path.length - 1 > max) return null;
  return {
    puzzle: { startId: saved.puzzle.startId, targetId: saved.puzzle.targetId, shortestPath: path },
    path: saved.path,
    moves: Number.isSafeInteger(saved.moves) && saved.moves! >= saved.path.length - 1 ? saved.moves! : saved.path.length - 1,
    hintedPaths: Array.isArray(saved.hintedPaths) ? [...new Set(saved.hintedPaths.filter(key => typeof key === 'string'))].slice(0, 10000) : [],
    revealed: saved.revealed === true,
  };
}
