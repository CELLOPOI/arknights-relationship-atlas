import type { Network } from './network.ts';

// “认识”只表示两人有直接连线，不改变原档案的关系种类和方向。见 docs/GAME.md。
export const RECOGNITION_SIZE = 10;
export const RECOGNITION_CONNECTED_COUNT = 5;
export interface RecognitionPair { leftId: string; rightId: string }
export interface RecognitionQuestion extends RecognitionPair { options: string[] }
export interface RecognitionAnswer { knows: boolean; bridgeId: string | null }
export interface RecognitionRound { questions: RecognitionQuestion[]; index: number; answers: RecognitionAnswer[] }

function pairKey(pair: RecognitionPair) { return JSON.stringify([pair.leftId, pair.rightId].sort()); }
export function knowsEachOther(network: Network, pair: RecognitionPair): boolean {
  return !!network.neighbors.get(pair.leftId)?.has(pair.rightId);
}
export function isRecognitionBridge(network: Network, pair: RecognitionPair, id: string): boolean {
  return id !== pair.leftId && id !== pair.rightId
    && !!network.neighbors.get(pair.leftId)?.has(id) && !!network.neighbors.get(pair.rightId)?.has(id);
}
function hasBridge(network: Network, pair: RecognitionPair): boolean {
  for (const id of network.neighbors.get(pair.leftId)?.keys() || []) {
    if (network.neighbors.get(pair.rightId)?.has(id)) return true;
  }
  return false;
}
function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}
function bridgeOptions(network: Network, pair: RecognitionPair, random: () => number): string[] {
  const valid: string[] = [], decoys: string[] = [];
  for (const id of network.people.keys()) {
    if (id === pair.leftId || id === pair.rightId) continue;
    (isRecognitionBridge(network, pair, id) ? valid : decoys).push(id);
  }
  const answers = shuffle(valid, random).slice(0, 2);
  return shuffle([...answers, ...shuffle(decoys, random).slice(0, 6 - answers.length)], random);
}

export function newRecognitionRound(network: Network, previous?: RecognitionRound | null, random = Math.random): RecognitionRound | null {
  const ids = [...network.people.keys()];
  const previousPairs = new Set(previous?.questions.map(pairKey));
  const pools = [
    { count: 0, freshCount: 0, pairs: [] as RecognitionPair[], fresh: [] as RecognitionPair[], size: RECOGNITION_SIZE - RECOGNITION_CONNECTED_COUNT },
    { count: 0, freshCount: 0, pairs: [] as RecognitionPair[], fresh: [] as RecognitionPair[], size: RECOGNITION_CONNECTED_COUNT },
  ];
  function sample(pairs: RecognitionPair[], pair: RecognitionPair, count: number, size: number) {
    if (pairs.length < size) pairs.push(pair);
    else {
      const index = Math.floor(random() * count);
      if (index < size) pairs[index] = pair;
    }
  }
  // 不直接相连的题必须能经过一人接通，确保第二步的候选池有解。
  for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) {
    const pair = { leftId: ids[left], rightId: ids[right] };
    const connected = knowsEachOther(network, pair);
    if (!connected && !hasBridge(network, pair)) continue;
    const pool = pools[Number(connected)];
    sample(pool.pairs, pair, ++pool.count, pool.size);
    if (!previousPairs.has(pairKey(pair))) sample(pool.fresh, pair, ++pool.freshCount, pool.size);
  }
  if (pools.some(pool => pool.count < pool.size)) return null;
  const questions = pools.flatMap(pool => pool.freshCount >= pool.size ? pool.fresh : pool.pairs)
    .map(pair => random() < .5 ? pair : { leftId: pair.rightId, rightId: pair.leftId })
    .map(pair => ({ ...pair, options: knowsEachOther(network, pair) ? [] : bridgeOptions(network, pair, random) }));
  return { questions: shuffle(questions, random), index: 0, answers: [] };
}

export function answerRecognition(round: RecognitionRound, answer: boolean): RecognitionRound | null {
  if (round.answers.length !== round.index || typeof answer !== 'boolean') return null;
  return { ...round, answers: [...round.answers, { knows: answer, bridgeId: null }] };
}

export function answerRecognitionBridge(network: Network, round: RecognitionRound, id: string): RecognitionRound | null {
  const answer = round.answers[round.index];
  const question = round.questions[round.index];
  if (!answer || answer.bridgeId !== null || knowsEachOther(network, question) || !question.options.includes(id)) return null;
  return { ...round, answers: round.answers.map((value, index) => index === round.index ? { ...value, bridgeId: id } : value) };
}

export function recognitionQuestionComplete(round: RecognitionRound, index = round.index): boolean {
  const answer = round.answers[index];
  return !!answer && (!round.questions[index].options.length || answer.bridgeId !== null);
}

export function nextRecognition(round: RecognitionRound): RecognitionRound | null {
  if (!recognitionQuestionComplete(round) || round.index >= round.questions.length - 1) return null;
  return { ...round, index: round.index + 1 };
}

export function recognitionScore(network: Network, round: RecognitionRound): number {
  return round.answers.filter((answer, index) => recognitionQuestionComplete(round, index)
    && answer.knows === knowsEachOther(network, round.questions[index])
    && (!round.questions[index].options.length || !!answer.bridgeId && isRecognitionBridge(network, round.questions[index], answer.bridgeId))).length;
}

export function restoreRecognition(value: unknown, network: Network): RecognitionRound | null {
  if (!value || typeof value !== 'object') return null;
  const round = value as RecognitionRound;
  if (!Array.isArray(round.questions) || round.questions.length !== RECOGNITION_SIZE
    || !Number.isInteger(round.index) || round.index < 0 || round.index >= RECOGNITION_SIZE
    || !Array.isArray(round.answers)
    || (round.answers.length !== round.index && round.answers.length !== round.index + 1)) return null;
  const questions: RecognitionQuestion[] = [];
  for (const pair of round.questions) {
    if (!pair || typeof pair !== 'object' || typeof pair.leftId !== 'string' || typeof pair.rightId !== 'string'
      || pair.leftId === pair.rightId || !network.people.has(pair.leftId) || !network.people.has(pair.rightId)) return null;
    if (!Array.isArray(pair.options) || pair.options.length > 6 || new Set(pair.options).size !== pair.options.length
      || pair.options.some(id => typeof id !== 'string' || id === pair.leftId || id === pair.rightId || !network.people.has(id))) return null;
    const connected = knowsEachOther(network, pair);
    if (connected ? pair.options.length !== 0 : !pair.options.some(id => isRecognitionBridge(network, pair, id))) return null;
    questions.push({ leftId: pair.leftId, rightId: pair.rightId, options: [...pair.options] });
  }
  if (new Set(questions.map(pairKey)).size !== RECOGNITION_SIZE
    || questions.filter(pair => knowsEachOther(network, pair)).length !== RECOGNITION_CONNECTED_COUNT) return null;
  const answers: RecognitionAnswer[] = [];
  for (const [index, answer] of round.answers.entries()) {
    if (!answer || typeof answer !== 'object' || typeof answer.knows !== 'boolean'
      || (answer.bridgeId !== null && (typeof answer.bridgeId !== 'string' || !questions[index].options.includes(answer.bridgeId)))
      || (index < round.index && questions[index].options.length > 0 && answer.bridgeId === null)) return null;
    answers.push({ knows: answer.knows, bridgeId: answer.bridgeId });
  }
  return { questions, index: round.index, answers };
}
