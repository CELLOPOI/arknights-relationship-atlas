<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Network } from './network';
import { completionPath, completionWon, excludedCandidate, fillGap, resetCompletion, type CompletionRound } from './completion';
import { completionSolutions } from './solutions';
import SolutionList from './SolutionList.vue';
import PersonAvatar from './PersonAvatar.vue';
import GameIcon from './GameIcon.vue';

const props = defineProps<{ round: CompletionRound; network: Network; busy: boolean }>();
const emit = defineEmits<{ update: [round: CompletionRound]; next: []; evidence: [id: string] }>();
const inspecting = ref('');
const notice = ref('');
const heading = ref<HTMLHeadingElement>();
const path = computed(() => completionPath(props.round));
const won = computed(() => completionWon(props.round));
const finished = computed(() => won.value || props.round.revealed);
const anchors = computed(() => [props.round.puzzle.shortestPath[props.round.activeGap - 1], props.round.puzzle.shortestPath[props.round.activeGap + 1]].map(id => props.network.people.get(id)!));
const candidate = computed(() => props.network.people.get(inspecting.value));
const choices = computed(() => props.round.options[props.round.activeGap].map(id => props.network.people.get(id)!));
const excluded = computed(() => excludedCandidate(props.network, props.round));
const hintUsed = computed(() => props.round.hintedGaps.includes(props.round.activeGap));
const solutions = computed(() => completionSolutions(props.network, props.round));
watch([() => props.round.puzzle, () => props.round.activeGap], () => { inspecting.value = ''; notice.value = ''; });

function choose(id: string) {
  if (props.busy) return;
  const index = props.round.activeGap;
  const next = fillGap(props.network, props.round, id);
  if (!next) return;
  if (next.answers[index]) notice.value = '两侧连线成立，已填入。';
  else { notice.value = '这位人物不能同时连接两侧，请重新选择。'; inspecting.value = id; }
  emit('update', next);
}

function hint() {
  if (props.busy || finished.value || hintUsed.value || !excluded.value) return;
  if (inspecting.value === excluded.value) inspecting.value = '';
  notice.value = '已排除一位错误候选。本空位的提示已用完。';
  emit('update', { ...props.round, hintedGaps: [...new Set([...props.round.hintedGaps, props.round.activeGap])] });
}

function retry() { inspecting.value = ''; notice.value = ''; emit('update', resetCompletion(props.round)); }
</script>

<template>
  <div class="game-completion">
    <section class="game-route-section" aria-label="待补全路线">
      <div class="game-route-heading"><h2>补全路线</h2><p><strong>{{ Object.keys(round.answers).length }}</strong><span>/ {{ round.gaps.length }} 处</span></p></div>
      <ol class="game-route game-completion-route" :style="{ '--route-count': path.length }">
        <li v-for="(id, index) in path" :key="index" class="game-step" :class="{ filled: id, current: !finished && index === round.activeGap, connected: id && path[index + 1] }">
          <button v-if="round.gaps.includes(index) && !id && !finished" class="game-step-avatar" :aria-label="`选择第 ${index} 步空位`" :aria-pressed="index === round.activeGap" :disabled="busy" @click="emit('update', { ...round, activeGap: index })"><span>?</span></button>
          <div v-else class="game-step-avatar"><PersonAvatar v-if="id" :person="network.people.get(id)!" eager /><span v-else>?</span></div>
          <span class="game-step-name">{{ id ? network.people.get(id)!.name : `第 ${index} 步` }}</span>
        </li>
      </ol>
    </section>
    <div class="game-action-row">
      <button class="game-text-button" :disabled="busy || finished || hintUsed || !excluded" @click="hint"><GameIcon name="hint" />{{ hintUsed ? '本空位提示已用' : '提示：排除一人' }}<span v-if="round.hintedGaps.length">{{ round.hintedGaps.length }}</span></button>
      <button class="game-text-button game-another" :disabled="busy" @click="emit('next')"><GameIcon name="refresh" />换一道题</button>
    </div>
    <p v-if="notice && !finished" class="game-notice" role="status">{{ notice }}</p>
    <section v-if="!finished" class="game-choices" aria-labelledby="completion-heading">
      <div class="game-choices-heading"><div><h2 id="completion-heading" ref="heading" tabindex="-1">谁能连接两侧？</h2><p>{{ anchors[0].name }}<span aria-hidden="true"> → </span>？<span aria-hidden="true"> → </span>{{ anchors[1].name }}</p></div></div>
      <p class="game-entry-help" role="status">{{ candidate ? `已选择${candidate.name}，点击填入后判断。` : '选择能连接两侧的人物，再确认填入。每处空位可用一次排除提示。' }}</p>
      <ul class="game-completion-candidates" aria-label="补全候选人物">
        <li v-for="person in choices" :key="person.id" :data-completion-id="person.id" :class="{ inspected: inspecting === person.id, excluded: hintUsed && excluded === person.id }">
          <button class="game-completion-inspect" :aria-label="`选择${person.name}`" :aria-pressed="inspecting === person.id" :disabled="busy || (hintUsed && excluded === person.id)" @click="inspecting = person.id">
            <PersonAvatar :person="person" /><span><strong>{{ person.name }}</strong><small>{{ hintUsed && excluded === person.id ? '提示已排除' : person.factionName }}</small></span><small>选择</small>
          </button>
          <button class="game-completion-fill" :aria-label="`填入${person.name}`" :disabled="busy || (hintUsed && excluded === person.id)" @click="choose(person.id)">填入<GameIcon name="arrow" /></button>
        </li>
      </ul>
      <div class="game-play-footer"><span>两侧都有连线即可，不限唯一答案。</span><button class="game-text-button" :disabled="busy" @click="emit('update', { ...round, revealed: true })">结束本局并看答案</button></div>
    </section>
    <section v-else class="game-result" :data-result="won ? 'won' : 'revealed'" aria-labelledby="completion-result-title">
      <h2 id="completion-result-title" tabindex="-1">{{ won ? '路线已补全' : '本局已结束' }}</h2>
      <p>{{ won ? '每一段都有已收录的关系，可以查看沿途原文。' : '下方可查看本题的有效补全路线。' }}</p>
      <p class="game-result-meta">作答 {{ round.attempts }} 次 · 提示 {{ round.hintedGaps.length }} 次</p>
      <div class="game-result-actions"><button class="game-button primary" :disabled="busy" @click="emit('next')">下一题<GameIcon name="arrow" /></button><button class="game-button" :disabled="busy" @click="retry">重试本题</button></div>
      <SolutionList :network="network" :primary="won ? path as string[] : round.puzzle.shortestPath" :solutions="solutions" :label="won ? '本次路线' : '参考路线'" @evidence="emit('evidence', $event)" />
    </section>
  </div>
</template>
