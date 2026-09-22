<script setup lang="ts">
import { computed } from 'vue';
import type { Network } from './network';
import type { Solutions } from './solutions';
import GameIcon from './GameIcon.vue';

const props = defineProps<{ network: Network; primary: string[]; solutions: Solutions; label: string }>();
const emit = defineEmits<{ evidence: [id: string] }>();
const others = computed(() => props.solutions.paths.filter(path => path.join('>') !== props.primary.join('>')));
</script>

<template>
  <div class="game-solution">
    <h3>{{ label }} · {{ primary.length - 1 }} 步</h3>
    <ol><li v-for="(id, index) in primary" :key="id"><button v-if="index" class="game-solution-edge" :aria-label="`查看${network.people.get(primary[index - 1])!.name}与${network.people.get(id)!.name}的关系`" @click="emit('evidence', network.neighbors.get(primary[index - 1])!.get(id)!)"><GameIcon name="arrow" /></button><span>{{ network.people.get(id)!.name }}</span></li></ol>
    <details v-if="others.length" class="game-other-solutions">
      <summary>其他有效路线（{{ others.length }} 条）</summary>
      <div v-for="(path, number) in others" :key="path.join('>')" class="game-alternate-route">
        <h4>路线 {{ number + 2 }} · {{ path.length - 1 }} 步</h4>
        <ol><li v-for="(id, index) in path" :key="id"><button v-if="index" class="game-solution-edge" :aria-label="`查看路线 ${number + 2} 的第 ${index} 段关系`" @click="emit('evidence', network.neighbors.get(path[index - 1])!.get(id)!)"><GameIcon name="arrow" /></button><span>{{ network.people.get(id)!.name }}</span></li></ol>
      </div>
    </details>
    <p v-else>{{ solutions.limited ? '目前找到这一条有效路线。' : '本题规则下只有这一条有效路线。' }}</p>
    <p>点击连线查看关系原文。{{ solutions.limited ? '这里列出部分有效路线。' : '' }}</p>
  </div>
</template>
