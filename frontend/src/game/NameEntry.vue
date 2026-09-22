<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GamePerson } from './network';
import { matchNames, uniqueExactMatch } from './names';
import GameIcon from './GameIcon.vue';
import PersonAvatar from './PersonAvatar.vue';

const props = defineProps<{ people: GamePerson[]; currentId: string; busy: boolean; feedback: string }>();
const emit = defineEmits<{ choose: [id: string, appearanceId?: string]; clear: [] }>();
const input = ref('');
const notice = ref('');
const field = ref<HTMLInputElement>();
const composing = ref(false);
let compositionEnded = 0;
const matches = computed(() => matchNames(props.people, input.value));
watch(() => props.currentId, () => { input.value = ''; notice.value = ''; });

function submit() {
  if (props.busy || composing.value || Date.now() - compositionEnded < 80 || !input.value.trim()) return;
  const person = uniqueExactMatch(matches.value);
  if (person) { notice.value = ''; emit('choose', person.id, person.appearanceId); }
  else notice.value = matches.value.length ? '请从下方确认具体人物，再连线。' : '未找到匹配人物，请换用代号、真名或更完整的名字。';
}

function enter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || composing.value) return;
  event.preventDefault(); submit();
}

function clear() { input.value = ''; notice.value = ''; emit('clear'); field.value?.focus(); }
</script>

<template>
  <div class="game-name-entry">
    <form @submit.prevent="submit">
      <label for="game-name-input" class="game-input-label">输入下一位人物</label>
      <div class="game-name-form">
        <div class="game-search">
          <GameIcon name="search" />
          <input id="game-name-input" ref="field" v-model="input" maxlength="100" autocomplete="off" :spellcheck="false" :disabled="busy" placeholder="代号、真名或绰号" aria-describedby="game-name-help game-name-status" @input="notice = ''; emit('clear')" @keydown.enter="enter" @compositionstart="composing = true" @compositionend="composing = false; compositionEnded = Date.now()" />
          <button v-if="input" type="button" class="game-clear" aria-label="清除输入的名字" :disabled="busy" @click="clear"><GameIcon name="close" /></button>
        </div>
        <button type="submit" class="game-button primary" :disabled="busy || !input.trim()">确认连线</button>
      </div>
      <p id="game-name-help" class="game-entry-help">支持部分名字和常用绰号；匹配结果只用于认人，确认后检查连线。</p>
    </form>
    <p id="game-name-status" class="game-entry-status" role="status">{{ feedback || notice || (input.trim() ? (matches.length ? `匹配到 ${matches.length} 位人物` : '没有匹配的人物，试试其他称呼。') : '例如：阿黛尔、小火龙、德克。') }}</p>
    <ul v-if="input.trim() && matches.length" class="game-name-matches" aria-label="姓名匹配结果">
      <li v-for="match in matches.slice(0, 8)" :key="match.person.id">
        <button type="button" :data-name-id="match.person.id" :data-appearance-id="match.person.appearanceId" :disabled="busy" :aria-label="`确认连接${match.person.name}`" @click="notice = ''; emit('choose', match.person.id, match.person.appearanceId)">
          <PersonAvatar :person="match.person" />
          <span><strong>{{ match.person.name }}</strong><small>{{ match.alias !== match.person.name ? `匹配称呼：${match.alias}` : match.person.factionName }}</small></span>
          <GameIcon name="arrow" />
        </button>
      </li>
    </ul>
    <p v-if="matches.length > 8" class="game-entry-help">显示前 8 位，补充名字可以缩小范围。</p>
  </div>
</template>
