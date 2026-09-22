<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '../api';
import SourceList from './SourceList.vue';
import { user, communityEnabled } from '../session';
import type { Comment, Page, Person, Relation, Target, FeedbackTarget } from '../types';

const props = defineProps<{ target: Target | null }>();
const emit = defineEmits<{ close: []; feedback: [target: FeedbackTarget]; login: []; navigate: [id: string, isOperator: boolean] }>();
const dialog = ref<HTMLDialogElement>();
const person = ref<Person | null>(null);
const relation = ref<Relation | null>(null);
const comments = ref<Page<Comment>>({ results: [], count: 0, page: 1, hasNext: false });
const tab = ref('details');
const loading = ref(false);
const busy = ref(false);
const saved = ref(false);
const error = ref('');
const feedback = ref('');
const body = ref('');
const explanation = ref('');
const evidence = ref('');
const reporting = ref<number | null>(null);
const reportReason = ref('');
const deleting = ref<number | null>(null);
let sequence = 0;
const title = computed(() => person.value?.name || relation.value?.title || '正在读取档案');
const direction = computed(() => relation.value?.people.find(p => p.id === relation.value?.from)?.name + ' 知晓 ' + relation.value?.people.find(p => p.id === relation.value?.to)?.name);
const query = (target = props.target) => new URLSearchParams(target ? { ...target } : {}).toString();

async function load() {
  if (!props.target) return;
  const request = ++sequence;
  const target = { ...props.target };
  loading.value = true; error.value = ''; feedback.value = ''; person.value = null; relation.value = null;
  try {
    const detail = await api<Person | Relation>(`${target.targetType === 'person' ? 'people' : 'relationships'}/${encodeURIComponent(target.targetId)}/`);
    const discussion = communityEnabled.value ? await api<Page<Comment>>(`comments/?${query(target)}`) : { results: [], count: 0, page: 1, hasNext: false };
    if (request !== sequence) return;
    if (target.targetType === 'person') person.value = detail as Person; else relation.value = detail as Relation;
    comments.value = discussion;
    saved.value = false;
    if (communityEnabled.value && user.value) {
      const result = await api<{ saved: boolean }>(`favorites/?${query(target)}`);
      if (request === sequence) saved.value = result.saved;
    }
  } catch (reason) { if (request === sequence) error.value = (reason as Error).message; }
  finally { if (request === sequence) loading.value = false; }
}

watch(() => props.target, async target => {
  await nextTick();
  if (!target) { sequence++; dialog.value?.close(); return; }
  if (!dialog.value?.open) dialog.value?.showModal();
  tab.value = 'details'; body.value = ''; explanation.value = ''; evidence.value = ''; reporting.value = null; deleting.value = null;
  await load();
});
watch(user, () => { if (props.target) load(); });

async function commentPage(page = 1) {
  const request = sequence;
  const result = await api<Page<Comment>>(`comments/?${query()}&page=${page}`);
  if (request === sequence) comments.value = result;
}

async function act(action: (isCurrent: () => boolean) => Promise<void>) {
  if (!user.value) { emit('login'); return; }
  if (busy.value) return;
  const request = sequence;
  busy.value = true; error.value = ''; feedback.value = '';
  try { await action(() => request === sequence); }
  catch (reason) { if (request === sequence) error.value = (reason as Error).message; }
  finally { busy.value = false; }
}

function favorite() { act(async current => { const result = await api<{ saved: boolean }>('favorites/', saved.value ? 'DELETE' : 'POST', props.target); if (current()) saved.value = result.saved; }); }
function postComment() { act(async current => { await api('comments/', 'POST', { ...props.target, body: body.value }); if (!current()) return; body.value = ''; await commentPage(); if (current()) feedback.value = '评论已发布。'; }); }
function removeComment(id: number) { act(async current => { await api(`comments/${id}/`, 'DELETE'); if (!current()) return; deleting.value = null; await commentPage(comments.value.page); }); }
function report(id: number) { act(async current => { await api(`comments/${id}/report/`, 'POST', { reason: reportReason.value }); if (!current()) return; reporting.value = null; reportReason.value = ''; feedback.value = '举报已提交，管理员会核查。'; }); }
function supplement() { act(async current => { const result = await api<{ detail: string }>('submissions/', 'POST', { ...props.target, body: explanation.value, evidence: evidence.value }); if (!current()) return; explanation.value = ''; evidence.value = ''; feedback.value = result.detail; }); }
async function changePage(page: number) { const request = sequence; loading.value = true; error.value = ''; try { await commentPage(page); } catch (reason) { if (request === sequence) error.value = (reason as Error).message; } finally { if (request === sequence) loading.value = false; } }
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
</script>

<template>
  <dialog ref="dialog" id="community-dialog" class="archive-dialog record-dialog" aria-labelledby="record-heading" @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close'); }">
    <div class="archive-dialog-surface">
      <header class="archive-dialog-header"><h2 id="record-heading">{{ title }}</h2><button class="archive-close" aria-label="关闭档案详情" @click="emit('close')"><svg aria-hidden="true"><use href="#i-close" /></svg></button></header>
      <div class="archive-dialog-body">
        <div v-if="person" class="record-identity"><img :src="person.avatar" alt=""><div><p>{{ person.factionName }}</p><span>{{ person.isOperator ? '干员' : 'NPC' }} · 人物档案</span></div><button class="archive-text-button" @click="emit('navigate', person.id, person.isOperator)">查看关系图<svg aria-hidden="true"><use href="#i-arrow-up-right" /></svg></button></div>
        <div v-if="relation" class="record-relation"><div class="record-pair"><button v-for="p in relation.people" :key="p.id" @click="emit('navigate', p.id, p.isOperator)"><img :src="p.avatar" alt=""><span>{{ p.name }}</span></button></div><p :class="{ awareness: relation.kind === 'awareness' }">{{ relation.kind === 'mutual' ? '确认相识' : direction }}</p></div>
        <button v-if="communityEnabled && (person || relation)" class="archive-button secondary favorite-action" :class="{ saved }" :aria-pressed="saved" :disabled="busy" @click="favorite"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4Z" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>{{ saved ? '已收藏 · 取消收藏' : '收藏这份档案' }}</button>
        <button v-if="target && (person || relation)" class="archive-button secondary favorite-action" @click="emit('feedback', { ...target, title })">反馈这份资料</button>
        <nav v-if="communityEnabled" class="archive-tabs" aria-label="档案详情栏目"><button :aria-current="tab === 'discussion' ? 'page' : undefined" @click="tab = 'discussion'">讨论 <span>{{ comments.count }}</span></button><button :aria-current="tab === 'details' ? 'page' : undefined" @click="tab = 'details'">{{ relation ? '原文依据' : '人物资料' }}</button><button :aria-current="tab === 'contribute' ? 'page' : undefined" @click="tab = 'contribute'">补充资料</button></nav>
        <p v-if="error" class="archive-feedback error" role="alert">{{ error }} <button class="archive-text-button" @click="load">重新读取</button></p>
        <p v-if="feedback" class="archive-feedback" role="status">{{ feedback }}</p>
        <p v-if="loading" class="archive-empty" role="status">正在读取档案…</p>
        <template v-else-if="person || relation">
          <section v-if="communityEnabled && tab === 'discussion'" aria-label="档案讨论">
            <form v-if="user" class="archive-form comment-form" @submit.prevent="postComment"><label>以 {{ user.username }} 的身份发表评论<textarea v-model="body" name="comment" rows="3" maxlength="3000" placeholder="分享你发现的剧情细节或关系依据" required /></label><div class="form-footer"><span>正式资料的修改请使用“补充资料”</span><button class="archive-button" :disabled="busy || !body.trim()">{{ busy ? '正在提交…' : '发布评论' }}</button></div></form>
            <p v-else class="archive-signin"><button class="archive-text-button" @click="emit('login')">登录后参与讨论</button><span>已有评论无需登录即可阅读。</span></p>
            <p v-if="!comments.results.length" class="archive-empty">暂无评论。</p>
            <ol v-else class="comment-list"><li v-for="comment in comments.results" :key="comment.id"><div class="comment-meta"><strong>{{ comment.author }}</strong><time :datetime="comment.createdAt">{{ date(comment.createdAt) }}</time></div><p class="comment-body">{{ comment.body }}</p><div class="comment-actions"><template v-if="comment.isOwn"><button v-if="deleting !== comment.id" class="archive-text-button" @click="deleting = comment.id">删除</button><template v-else><span>删除这条评论？</span><button class="archive-text-button" :disabled="busy" @click="removeComment(comment.id)">确定删除</button><button class="archive-text-button" @click="deleting = null">取消</button></template></template><button v-else class="archive-text-button" @click="user ? reporting = comment.id : emit('login')">举报</button></div><form v-if="reporting === comment.id" class="archive-form report-form" @submit.prevent="report(comment.id)"><label>举报原因<textarea v-model="reportReason" maxlength="500" rows="2" required /></label><div class="form-footer"><button type="button" class="archive-text-button" @click="reporting = null">取消</button><button class="archive-button secondary" :disabled="busy">提交举报</button></div></form></li></ol>
            <div v-if="comments.count > 30" class="archive-pagination"><button :disabled="comments.page <= 1" @click="changePage(comments.page - 1)">上一页</button><span>{{ comments.page }}</span><button :disabled="!comments.hasNext" @click="changePage(comments.page + 1)">下一页</button></div>
          </section>
          <section v-else-if="!communityEnabled || tab === 'details'" class="record-evidence">
            <template v-if="person"><h3>称呼与别名</h3><p>{{ person.aliases.join('、') || person.name }}</p><h3>{{ person.isOperator ? '当前阵营' : '资料归类' }}</h3><p>{{ person.factionName }}</p><p v-if="!person.isOperator" class="archive-muted">按资料中的国家或组织归类，包含历史归属。</p><template v-if="person.avatarSource"><h3>头像来源</h3><p v-if="person.avatarIsGeneric" class="archive-muted">此为通用立绘，仅代表角色的大致形象。</p><p><a class="archive-text-button" :href="person.avatarSource" target="_blank" rel="noopener noreferrer">查看 PRTS 原图</a></p></template><button class="archive-button secondary" @click="emit('navigate', person.id, person.isOperator)">探索相关人物</button></template>
            <template v-if="relation"><p class="record-note">{{ relation.note || '关系判定依据见下方原文。' }}</p><article v-for="item in relation.evidence" :key="item.id"><h3>关键原文</h3><blockquote>{{ item.quote }}</blockquote><SourceList :sources="item.sources" /></article></template>
          </section>
          <section v-else aria-label="补充资料"><p class="archive-intro">发现遗漏或需要修正的地方，请附上说明与出处。补充经审核后进入正式资料。</p><form v-if="user" class="archive-form" @submit.prevent="supplement"><label>需要补充或修正什么<textarea v-model="explanation" name="explanation" rows="4" maxlength="6000" required /></label><label>相关原文与出处<textarea v-model="evidence" name="evidence" rows="5" maxlength="12000" placeholder="例如活动名称、章节、原文片段或档案条目" /></label><button class="archive-button" :disabled="busy || !explanation.trim()">{{ busy ? '正在提交…' : '提交补充' }}</button><p class="archive-muted">审核状态和意见可在“我的档案 → 我的补充”查看。</p></form><button v-else class="archive-button" @click="emit('login')">登录后提交补充</button></section>
        </template>
      </div>
    </div>
  </dialog>
</template>
