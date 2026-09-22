<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Network } from './network';
import { answerRecognition, answerRecognitionBridge, isRecognitionBridge, knowsEachOther, nextRecognition, recognitionQuestionComplete, recognitionScore, type RecognitionRound } from './recognition';
import GameIcon from './GameIcon.vue';
import PersonAvatar from './PersonAvatar.vue';
import SolutionList from './SolutionList.vue';

const props = defineProps<{ round: RecognitionRound; network: Network; busy: boolean }>();
const emit = defineEmits<{ update: [round: RecognitionRound]; next: []; evidence: [id: string] }>();
const selectedBridge = ref('');
const pair = computed(() => props.round.questions[props.round.index]);
const answered = computed(() => props.round.answers.length > props.round.index);
const connected = computed(() => knowsEachOther(props.network, pair.value));
const answer = computed(() => props.round.answers[props.round.index]);
const directCorrect = computed(() => answer.value?.knows === connected.value);
const bridgeCorrect = computed(() => !!answer.value?.bridgeId && isRecognitionBridge(props.network, pair.value, answer.value.bridgeId));
const correct = computed(() => directCorrect.value && (connected.value || bridgeCorrect.value));
const finished = computed(() => recognitionQuestionComplete(props.round));
const complete = computed(() => props.round.answers.length === props.round.questions.length && finished.value);
const completedCount = computed(() => props.round.answers.filter((_, index) => recognitionQuestionComplete(props.round, index)).length);
const score = computed(() => recognitionScore(props.network, props.round));
const edgeId = computed(() => props.network.neighbors.get(pair.value.leftId)?.get(pair.value.rightId));
const left = computed(() => props.network.people.get(pair.value.leftId)!);
const right = computed(() => props.network.people.get(pair.value.rightId)!);
const options = computed(() => pair.value.options.map(id => props.network.people.get(id)!));
const solutions = computed(() => ({ paths: pair.value.options.filter(id => isRecognitionBridge(props.network, pair.value, id))
  .map(id => [pair.value.leftId, id, pair.value.rightId]), limited: false }));
const primary = computed(() => bridgeCorrect.value ? [pair.value.leftId, answer.value!.bridgeId!, pair.value.rightId] : solutions.value.paths[0]);

watch([() => props.round.index, () => props.round.questions], () => { selectedBridge.value = ''; });

function submit(choice: boolean) {
  if (props.busy || answered.value) return;
  const next = answerRecognition(props.round, choice);
  if (next) emit('update', next);
}
function submitBridge() {
  if (props.busy || !selectedBridge.value) return;
  const next = answerRecognitionBridge(props.network, props.round, selectedBridge.value);
  if (next) emit('update', next);
}
function next() {
  if (props.busy) return;
  const next = nextRecognition(props.round);
  if (next) emit('update', next);
}
</script>

<template>
  <section class="game-recognition" aria-labelledby="recognition-question">
    <div class="game-recognition-progress"><span>第 <strong>{{ round.index + 1 }}</strong> / {{ round.questions.length }} 题</span><span>已答 {{ completedCount }} 题 · 答对 {{ score }} 题</span></div>
    <h2 id="recognition-question" tabindex="-1">他们认识吗？</h2>
    <div class="game-recognition-options" role="group" aria-label="选择你的判断">
      <button v-for="choice in [true, false]" :key="String(choice)" class="game-recognition-option" :data-answer="String(choice)" :data-result="answer?.knows === choice ? directCorrect ? 'correct' : 'wrong' : undefined" :aria-pressed="answer?.knows === choice" :disabled="busy || answered" @click="submit(choice)">
        <span>{{ choice ? '认识' : '不认识' }}</span><small v-if="answer?.knows === choice">{{ directCorrect ? '正确' : '错误' }}</small>
      </button>
    </div>
    <template v-if="answered && !finished">
      <p class="game-notice game-recognition-feedback" :data-result="directCorrect ? 'correct' : 'wrong'" role="status">第一步{{ directCorrect ? '答对了' : '答错了' }}，两人没有直接连线。</p>
      <h2 id="recognition-heading" tabindex="-1">通过谁认识？</h2>
      <p class="game-entry-help">选择一位能同时连接{{ left.name }}与{{ right.name }}的人物。</p>
      <ul class="game-completion-candidates game-recognition-pool" aria-label="中间人候选">
        <li v-for="person in options" :key="person.id" :class="{ inspected: selectedBridge === person.id }">
          <button class="game-completion-inspect" :data-bridge-id="person.id" :aria-pressed="selectedBridge === person.id" :disabled="busy" @click="selectedBridge = person.id">
            <PersonAvatar :person="person" /><span><strong>{{ person.name }}</strong><small>{{ person.factionName }}</small></span><small v-if="selectedBridge === person.id">已选</small>
          </button>
        </li>
      </ul>
      <button class="game-button primary game-recognition-submit" :disabled="!selectedBridge || busy" @click="submitBridge">确认中间人<GameIcon name="arrow" /></button>
    </template>
    <div v-else-if="finished" class="game-result" :data-result="correct ? 'won' : 'lost'">
      <h2 id="recognition-heading" tabindex="-1">{{ correct ? '答对了' : '答错了' }}</h2>
      <p>你的判断：{{ answer!.knows ? '认识' : '不认识' }} · 答案：<strong>{{ connected ? '认识' : '不认识' }}</strong></p>
      <p v-if="connected" class="game-recognition-explanation">{{ left.name }}与{{ right.name }}有直接连线。</p>
      <p v-else class="game-recognition-explanation">你选择的{{ network.people.get(answer!.bridgeId!)!.name }}{{ bridgeCorrect ? '能同时连接两人。' : '无法同时连接两人。' }}{{ !directCorrect && bridgeCorrect ? '中间人选对了，但第一步判断有误。' : '' }}</p>
      <button v-if="edgeId" class="game-text-button" @click="emit('evidence', edgeId)">查看关系原文<GameIcon name="arrow" /></button>
      <SolutionList v-if="!connected" :network="network" :primary="primary" :solutions="solutions" label="候选中的有效路线" @evidence="emit('evidence', $event)" />
      <p v-if="complete" class="game-recognition-summary">本轮结束，答对 <strong>{{ score }}</strong> / {{ round.questions.length }} 题。</p>
      <div class="game-result-actions">
        <button v-if="complete" class="game-button primary" :disabled="busy" @click="emit('next')">{{ busy ? '正在抽题…' : '再玩一轮' }}<GameIcon name="refresh" /></button>
        <button v-else class="game-button primary" :disabled="busy" @click="next">下一题<GameIcon name="arrow" /></button>
      </div>
    </div>
  </section>
</template>
