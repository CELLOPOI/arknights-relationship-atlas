<script setup lang="ts">
import { computed, onDeactivated, ref, toRefs, watch } from 'vue';
import { preferenceDraft } from './session';
import PreferenceImage from './PreferenceImage.vue';
import ResultsView from './ResultsView.vue';
import { mutate, pendingMutation, PreferenceError, timeText } from './api';
import type { Catalog, Choice, State } from './types';

const props = defineProps<{ kind: 'form' | 'skin'; objectId: string; catalog: Catalog; state: State }>();
const emit = defineEmits<{ refresh: []; skin: [id: string] }>();
const draft = preferenceDraft(`choice:${props.state.choice_order_seed}:${props.kind}:${props.objectId}`, {
  selected: '', compare: [] as string[], busy: false, results: false, outfitOnly: false, draftVersion: 0,
  accepted: null as Choice | null,
});
const { selected, compare, busy, results, outfitOnly, draftVersion, accepted } = toRefs(draft);
const loaded = ref(new Set<string>()), failed = ref(new Set<string>()), error = ref(''), message = ref('');
const pending = ref(!!pendingMutation(`${props.kind}:${props.objectId}`));
const preview = ref<HTMLDialogElement>(), full = ref<{ name: string; image: string } | null>(null);
const owner = computed(() => props.kind === 'skin' ? props.catalog.forms.find(x => x.id === props.objectId) : props.catalog.persons.find(x => x.id === props.objectId));
const version = computed(() => props.kind === 'skin' ? props.catalog.forms.find(x => x.id === props.objectId)?.catalog_version || props.catalog.version : props.catalog.persons.find(x => x.id === props.objectId)?.form_catalog_version || props.catalog.version);
const saved = computed(() => accepted.value || props.state.choices.find(x => x.kind === props.kind && x.object_id === props.objectId));
const options = computed(() => {
  const rows = props.kind === 'skin'
    ? props.catalog.appearances.filter(x => x.form_id === props.objectId && x.eligible).map(x => ({ id: x.id, name: x.name, image: x.image_url, thumbnail: x.thumbnail_url, outfit: x.kind === 'outfit' }))
    : props.catalog.forms.filter(x => x.person_id === props.objectId && x.eligible).map(x => {
      const art = props.catalog.appearances.find(a => a.id === x.default_appearance_id);
      return { id: x.id, name: x.name, image: art?.image_url || x.representative_url || '', thumbnail: art?.thumbnail_url || x.representative_url || '', outfit: false };
    });
  function hash(id: string) { let value = 2166136261; for (const c of `${props.state.choice_order_seed}:${props.objectId}:${version.value}:${id}`) value = Math.imul(value ^ c.charCodeAt(0), 16777619); return value >>> 0; }
  return rows.sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
});
const visible = computed(() => options.value.filter(x => !outfitOnly.value || x.outfit));
const comparable = computed(() => options.value.filter(x => compare.value.includes(x.id)));
const complete = computed(() => props.kind === 'form' || props.catalog.forms.find(x => x.id === props.objectId)?.complete);
const canVote = computed(() => !!owner.value?.eligible && complete.value && options.value.length > 1);
const allReady = computed(() => options.value.every(x => loaded.value.has(x.id)) && !failed.value.size);
const conflict = computed(() => !!selected.value && draftVersion.value !== (saved.value?.version || 0));
const currentName = computed(() => saved.value?.action === 'none' ? '没有明显偏好' : options.value.find(x => x.id === saved.value?.choice_id)?.name || '尚未选择');
onDeactivated(() => preview.value?.close());
watch(() => props.state, () => {
  const fresh = props.state.choices.find(x => x.kind === props.kind && x.object_id === props.objectId);
  if (fresh && fresh.version >= (accepted.value?.version || 0)) accepted.value = null;
});
function choose(id: string) { if (pending.value || busy.value) return; if (!selected.value) draftVersion.value = saved.value?.version || 0; selected.value = id; error.value = ''; }
function toggleCompare(id: string) {
  if (compare.value.includes(id)) compare.value = compare.value.filter(x => x !== id);
  else if (compare.value.length < 3) compare.value = [...compare.value, id];
  else message.value = '最多同时比较三套，请先移除一套。';
}
function openPreview(option: { name: string; image: string }) { full.value = option; preview.value?.showModal(); }
function imageReady(id: string) { loaded.value.add(id); failed.value.delete(id); }
async function save(action: 'choose' | 'none' | 'withdraw' | 'confirm') {
  if (busy.value || !props.state.writes_enabled || (!pending.value && action === 'choose' && (!selected.value || conflict.value))) return;
  const object = props.objectId, kind = props.kind;
  const payload = { version: saved.value?.version || 0, catalog_version: version.value, ...(action === 'confirm' ? {} : { action }), ...(action === 'choose' ? { choice_id: selected.value } : {}) };
  busy.value = true; error.value = ''; message.value = '';
  try {
    const response = await mutate<Choice>(`${kind}:${object}`, `choices/${kind}/${encodeURIComponent(object)}/${action === 'confirm' ? 'confirm/' : ''}`, action === 'confirm' ? 'POST' : 'PUT', payload);
    pending.value = false;
    if (props.objectId === object) {
      accepted.value = response; selected.value = ''; draftVersion.value = response.version;
      message.value = props.state.risk_status === 'pending' ? '已登记，待确认后计入公共结果。' : action === 'withdraw' ? '已撤回登记。' : '已保存你的选择。';
    }
    emit('refresh');
  } catch (reason) {
    if (props.objectId === object) {
      pending.value = !!pendingMutation(`${kind}:${object}`);
      error.value = (reason as Error).message;
      if (reason instanceof PreferenceError && ['version_conflict', 'catalog_conflict'].includes(reason.code)) emit('refresh');
    }
  } finally { busy.value = false; }
}
</script>
<template>
  <div class="choice-editor"><p v-if="pending" class="pref-message">上次保存结果尚未确认，原外观和操作参数已保留。<button class="pref-secondary" :disabled="busy || !state.writes_enabled" @click="save('choose')">重试原登记</button></p>
    <div class="pref-tabs" aria-label="外观内容"><button :aria-pressed="!results" @click="results = false">{{ kind === 'skin' ? '选择立绘' : '选择形态' }}</button><button :aria-pressed="results" @click="results = true">结果与趋势</button></div>
    <ResultsView v-if="results" :catalog="catalog" :kind="kind" :object-id="objectId" />
    <div v-else>
      <p class="choice-question">{{ kind === 'skin' ? '只看立绘，你最喜欢这位干员的哪套外观？' : '你更喜欢这个人物的哪种形态？' }}</p>
      <p class="pref-muted">当前选择：{{ currentName }}<template v-if="saved?.next_change_at"> · 下次可修改：{{ timeText(saved.next_change_at) }}（北京时间）</template></p>
      <p v-if="saved && !saved.confirmed && saved.action !== 'withdraw'" class="pref-message">名录已更新。旧登记仍保留，请查看完整候选后确认。<button v-if="saved.available" class="pref-text" :disabled="busy || pending || !allReady || !state.writes_enabled" @click="save('confirm')">保持原选择</button></p>
      <p v-if="!complete" class="pref-message">目录整理中，当前形态暂未开放选择。</p>
      <p v-else-if="options.length < 2" class="pref-message">{{ kind === 'skin' ? '这个形态只有一种外观，可查看完整立绘。' : '当前人物没有可比较的多个形态。' }}</p>
      <label v-if="kind === 'skin' && options.some(x => x.outfit)" class="pref-check"><input v-model="outfitOnly" type="checkbox">只显示服饰（结果分母仍包含全部外观）</label>
      <div class="choice-options">
        <article v-for="option in options" v-show="visible.includes(option)" :key="option.id" class="choice-option" :class="{ selected: selected === option.id }">
          <div class="choice-preview"><PreferenceImage :src="option.image" :alt="option.name" @ready="imageReady(option.id)" @failed="failed.add(option.id); loaded.delete(option.id)" /><button class="choice-enlarge" :aria-label="`放大${option.name}完整立绘`" @click="openPreview(option)">放大</button></div>
          <div class="choice-option-name"><h3>{{ option.name }}</h3><span v-if="saved?.action === 'choose' && saved.choice_id === option.id">当前选择</span></div>
          <div class="choice-option-actions"><button v-if="canVote" :aria-pressed="selected === option.id" :disabled="busy || pending" @click="choose(option.id)">{{ selected === option.id ? '已暂选' : '选为最爱' }}</button><button :aria-pressed="compare.includes(option.id)" @click="toggleCompare(option.id)">{{ compare.includes(option.id) ? '移出比较' : '加入比较' }}</button></div>
          <button v-if="kind === 'form'" class="pref-text" @click="emit('skin', option.id)">查看这个形态的皮肤</button>
        </article>
      </div>
      <section v-if="comparable.length" class="choice-comparison" aria-label="临时立绘比较"><div class="pref-row"><h3>临时比较（{{ comparable.length }} / 3）</h3><button class="pref-text" @click="compare = []">清空比较</button></div><div class="choice-compare-images"><figure v-for="option in comparable" :key="option.id"><PreferenceImage :src="option.image" :alt="option.name" /><figcaption>{{ option.name }}</figcaption></figure></div></section>
      <div v-if="canVote" class="choice-confirm">
        <p v-if="!allReady" class="pref-muted">{{ failed.size ? '部分候选图片未加载成功，请重试图片后确认。' : '正在加载完整候选预览…' }}</p>
        <p v-if="conflict" role="alert">另一页面已更新选择。<button class="pref-text" @click="selected = ''; error = ''">清除草稿，重新选择</button></p>
        <p v-if="selected" class="pref-muted">待确认：{{ options.find(x => x.id === selected)?.name }}，尚未登记。</p>
        <div class="pref-actions"><button class="pref-primary" :disabled="busy || pending || !allReady || !selected || conflict || !state.writes_enabled" @click="save('choose')">{{ busy ? '保存中…' : '确认最爱' }}</button><button class="pref-secondary" :disabled="busy || pending || !allReady || !state.writes_enabled" @click="save('none')">没有明显偏好</button><button v-if="saved?.action && saved.action !== 'withdraw'" class="pref-text" :disabled="busy || pending || !state.writes_enabled" @click="save('withdraw')">撤回选择</button></div>
      </div>
      <p v-if="error" class="pref-error" role="alert">{{ error }}<button class="pref-text" @click="emit('refresh')">查询已保存状态</button></p><p v-if="message" class="pref-message" role="status">{{ message }}</p>
    </div>
    <dialog ref="preview" class="preference-lightbox" aria-label="完整立绘"><header><h2>{{ full?.name }}</h2><button class="pref-secondary" @click="preview?.close()">关闭大图</button></header><PreferenceImage v-if="full" :src="full.image" :alt="full.name" /></dialog>
  </div>
</template>
