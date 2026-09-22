import { MAX_STEPS, shortestPath, type Network } from './network.ts';
import { canFillGap, completionPath, type CompletionRound } from './completion.ts';

export const SOLUTION_LIMIT = 12;
export interface Solutions { paths: string[][]; limited: boolean }

export function findSolutions(network: Network, start: string, target: string, limit = SOLUTION_LIMIT): Solutions {
  const shortest = shortestPath(network, start, target);
  if (!shortest) return { paths: [], limited: false };
  const distances = new Map([[target, 0]]), queue = [target];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], depth = distances.get(id)!;
    if (depth === MAX_STEPS) continue;
    for (const next of network.neighbors.get(id)!.keys()) if (!distances.has(next)) {
      distances.set(next, depth + 1); queue.push(next);
    }
  }
  const paths: string[][] = [], path = [start], visited = new Set(path);
  let searched = 0, exhausted = false;
  function visit(id: string, remaining: number) {
    if (++searched > 50000) { exhausted = true; return; }
    if (id === target) { if (!remaining) paths.push([...path]); return; }
    if (!remaining || (distances.get(id) ?? Infinity) > remaining) return;
    for (const next of network.neighbors.get(id)!.keys()) {
      if (visited.has(next)) continue;
      visited.add(next); path.push(next); visit(next, remaining - 1); path.pop(); visited.delete(next);
      if (paths.length > limit || exhausted) return;
    }
  }
  // 按步数递增枚举，优先展示短路线；数量与搜索预算均有上限，避免稠密图阻塞页面。
  for (let steps = shortest.length - 1; steps <= MAX_STEPS; steps++) {
    visit(start, steps);
    if (paths.length > limit || exhausted) break;
  }
  return { paths: paths.slice(0, limit), limited: exhausted || paths.length > limit };
}

export function completionSolutions(network: Network, round: CompletionRound, limit = SOLUTION_LIMIT): Solutions {
  const paths: string[][] = [];
  function visit(index: number, answers: Record<number, string>) {
    const current = { ...round, answers };
    if (index === round.gaps.length) { paths.push(completionPath(current) as string[]); return; }
    const gap = round.gaps[index];
    for (const id of round.options[gap]) {
      if (!canFillGap(network, current, gap, id)) continue;
      visit(index + 1, { ...answers, [gap]: id });
      if (paths.length > limit) return;
    }
  }
  visit(0, {});
  return { paths: paths.slice(0, limit), limited: paths.length > limit };
}
