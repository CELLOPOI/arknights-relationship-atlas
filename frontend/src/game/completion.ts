import { shortestPath, validPath, type Difficulty, type Network, type Puzzle } from './network.ts';

export const COMPLETION_GAPS: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3 };

export interface CompletionRound {
  puzzle: Puzzle;
  gaps: number[];
  options: Record<number, string[]>;
  answers: Record<number, string>;
  activeGap: number;
  attempts: number;
  hintedGaps: number[];
  revealed: boolean;
}

function shuffle<T>(values: T[], random: () => number) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function newCompletionRound(network: Network, puzzle: Puzzle, difficulty: Difficulty, random = Math.random): CompletionRound {
  const path = puzzle.shortestPath;
  const count = COMPLETION_GAPS[difficulty];
  if (path.length !== count * 2 + 1) throw new RangeError('Completion path length must match the selected gap count.');
  // 空位不相邻，始终保留两侧人物供玩家对照；各空位的候选互斥，避免先答一处堵死另一处。
  const gaps = Array.from({ length: count }, (_, index) => index * 2 + 1);
  const used = new Set(path);
  const options: Record<number, string[]> = {};
  for (const index of gaps) {
    const left = network.neighbors.get(path[index - 1])!;
    const right = network.neighbors.get(path[index + 1])!;
    const nearby = [...new Set([...left.keys(), ...right.keys()])].filter(id => !used.has(id));
    const decoys = nearby.filter(id => !left.has(id) || !right.has(id));
    const alternatives = nearby.filter(id => left.has(id) && right.has(id));
    const choices = [path[index], ...shuffle(decoys, random).slice(0, 3), ...shuffle(alternatives, random).slice(0, 1)];
    for (const id of shuffle([...network.people.keys()].filter(id => !used.has(id) && !choices.includes(id)), random)) {
      if (choices.length >= 6) break;
      choices.push(id);
    }
    options[index] = shuffle(choices, random);
    choices.forEach(id => used.add(id));
  }
  return { puzzle, gaps, options, answers: {}, activeGap: gaps[0], attempts: 0, hintedGaps: [], revealed: false };
}

export function completionPath(round: CompletionRound): (string | null)[] {
  return round.puzzle.shortestPath.map((id, index) => round.gaps.includes(index) ? round.answers[index] || null : id);
}

export function completionWon(round: CompletionRound): boolean {
  return round.gaps.every(index => !!round.answers[index]);
}

export function canFillGap(network: Network, round: CompletionRound, index: number, id: string): boolean {
  if (!round.gaps.includes(index) || !round.options[index]?.includes(id)) return false;
  const path = completionPath(round);
  return !path.some((person, position) => position !== index && person === id)
    && !!network.neighbors.get(path[index - 1]!)?.has(id)
    && !!network.neighbors.get(id)?.has(path[index + 1]!);
}

export function fillGap(network: Network, round: CompletionRound, id: string): CompletionRound | null {
  if (round.revealed || completionWon(round) || round.answers[round.activeGap]
    || !round.options[round.activeGap]?.includes(id)) return null;
  const next = { ...round, attempts: round.attempts + 1 };
  if (canFillGap(network, round, round.activeGap, id)) {
    next.answers = { ...round.answers, [round.activeGap]: id };
    next.activeGap = round.gaps.find(index => !next.answers[index]) ?? round.activeGap;
  }
  return next;
}

export function excludedCandidate(network: Network, round: CompletionRound): string | undefined {
  return round.options[round.activeGap].find(id => !canFillGap(network, round, round.activeGap, id));
}

export function resetCompletion(round: CompletionRound): CompletionRound {
  return { ...round, answers: {}, activeGap: round.gaps[0], attempts: 0, hintedGaps: [], revealed: false };
}

export function restoreCompletion(value: unknown, network: Network, difficulty: Difficulty): CompletionRound | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Partial<CompletionRound>;
  const path = saved.puzzle?.shortestPath;
  if (!saved.puzzle || !Array.isArray(path) || !path.every(id => typeof id === 'string') || !validPath(network, path)
    || saved.puzzle.startId !== path[0] || saved.puzzle.targetId !== path.at(-1)) return null;
  const shortest = shortestPath(network, path[0], path[path.length - 1]);
  const count = COMPLETION_GAPS[difficulty];
  if (!shortest || shortest.length !== path.length || path.length !== count * 2 + 1) return null;
  if (!Array.isArray(saved.gaps) || saved.gaps.length !== count
    || saved.gaps.some((index, i) => index !== i * 2 + 1)
    || !saved.options || typeof saved.options !== 'object' || !saved.answers || typeof saved.answers !== 'object') return null;
  const used = new Set(path.filter((_, index) => !saved.gaps!.includes(index)));
  for (const index of saved.gaps) {
    const options = saved.options[index];
    if (!Array.isArray(options) || !options.length || options.length > 6 || !options.includes(path[index])
      || options.some(id => typeof id !== 'string' || !network.people.has(id) || used.has(id))
      || new Set(options).size !== options.length) return null;
    options.forEach(id => used.add(id));
  }
  if (Object.keys(saved.answers).some(key => !saved.gaps!.includes(Number(key)))) return null;
  const round: CompletionRound = {
    puzzle: { startId: path[0], targetId: path[path.length - 1], shortestPath: [...path] },
    gaps: [...saved.gaps], options: Object.fromEntries(saved.gaps.map(index => [index, [...saved.options![index]]])),
    answers: { ...saved.answers }, activeGap: saved.activeGap!, attempts: saved.attempts!,
    hintedGaps: Array.isArray(saved.hintedGaps) ? [...new Set(saved.hintedGaps.filter(index => saved.gaps!.includes(index)))] : [],
    revealed: saved.revealed === true,
  };
  if (!round.gaps.includes(round.activeGap) || !Number.isSafeInteger(round.attempts)
    || round.attempts < Object.keys(round.answers).length
    || Object.entries(round.answers).some(([index, id]) => !canFillGap(network, round, Number(index), id))) return null;
  if (!completionWon(round) && round.answers[round.activeGap]) round.activeGap = round.gaps.find(index => !round.answers[index])!;
  return round;
}
