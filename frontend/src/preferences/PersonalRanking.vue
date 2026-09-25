<script setup lang="ts">
import { computed } from 'vue';
import { buildPersonalRanking, PRACTICE_RECORD_LIMIT, practiceScopes, type PracticeScope } from './personal-ranking';
import type { Person, RecordItem } from './types';

const props = defineProps<{ records: RecordItem[]; persons: Person[]; scope: PracticeScope; disabled: boolean }>();
const emit = defineEmits<{ 'update:scope': [value: PracticeScope]; practice: [] }>();
const ranking = computed(() => buildPersonalRanking(props.records, props.persons, props.scope));
</script>

<template>
  <section class="personal-ranking" aria-labelledby="personal-ranking-title">
    <div class="pref-row">
      <h2 id="personal-ranking-title">我的喜好榜</h2>
      <button class="pref-secondary" :disabled="disabled" @click="emit('practice')">继续个人练习</button>
    </div>
    <p class="pref-muted">根据本机最近 {{ PRACTICE_RECORD_LIMIT }} 条练习自动更新，不进入公共榜。同一人物的不同形态合并统计。</p>
    <div class="pref-tabs" aria-label="个人榜单范围">
      <button v-for="item in practiceScopes" :key="item.value" :aria-pressed="scope === item.value" @click="emit('update:scope', item.value)">{{ item.label }}</button>
    </div>
    <p class="pref-muted" role="status">当前范围 {{ ranking.comparisons }} 组有效对位 · {{ ranking.rows.length }} 位人物入榜</p>
    <template v-if="ranking.rows.length">
      <p v-if="ranking.groups.length > 1" class="pref-message">还有 {{ ranking.groups.length }} 组人物未建立比较关系，暂时分别排名。继续练习会优先补上组间比较。</p>
      <p v-else class="pref-muted">这是根据已有选择得到的暂定顺序，继续比较后可能变化。</p>
      <div v-for="(group, index) in ranking.groups" :key="group.id" class="personal-ranking-group">
        <h3 v-if="ranking.groups.length > 1">比较组 {{ index + 1 }}<span>组内暂定排序</span></h3>
        <ol class="personal-ranking-list" :aria-label="ranking.groups.length > 1 ? `比较组 ${index + 1} 的喜好排名` : '个人喜好排名'">
          <li v-for="row in group.rows" :key="row.person.id" :data-person-id="row.person.id">
            <span class="personal-rank" :aria-label="`暂列第 ${row.rank} 名`">{{ row.rank }}</span>
            <div class="personal-ranked-person"><strong>{{ row.person.name }}</strong><span>{{ row.person.kind === 'npc' ? 'NPC' : '干员' }}</span></div>
            <div class="personal-ranking-evidence"><span>比较过 {{ row.comparisons }} 位</span><span>{{ row.wins }} 次胜出<template v-if="row.ties"> · {{ row.ties }} 次平局</template></span></div>
          </li>
        </ol>
      </div>
    </template>
    <div v-else class="preference-empty">
      <h3>当前范围还没有可排名的练习</h3>
      <p>选择更喜欢的人物或「难分高下」后，榜单会自动生成。跳过和不熟悉不计分。</p>
      <button class="pref-primary" :disabled="disabled" @click="emit('practice')">开始个人练习</button>
    </div>
    <details class="pref-history">
      <summary>榜单怎么算？</summary>
      <p>排序同时考虑你选了谁、对手的相对偏好，并缓和少量判断的影响。难分高下按平局处理，跳过和不熟悉不计入；相同结果并列。</p>
      <p>同一对人物只取最近一次明确选择或平局，新选择会更新旧判断。仅统计双方都在所选范围内、且仍可比较的记录；仅干员榜不使用与 NPC 的对位。</p>
      <p>未比较的人物不排名，没有比较关系的组不分先后。练习优先连接已有分组，并穿插新人物与排名接近的人物。样本较少时只反映初步偏好。</p>
      <p>记录只保存在当前浏览器，清除网站数据或本机练习记录会同时清空榜单。</p>
    </details>
  </section>
</template>
