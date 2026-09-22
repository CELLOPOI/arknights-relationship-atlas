<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '../api';
import { user, registrationEnabled, refreshSession, sessionError, sessionReady } from '../session';
import type { Page, SavedTarget, Submission, Target, User } from '../types';

const props = defineProps<{ open: boolean; initialAction?: string; token?: string; uid?: string }>();
const emit = defineEmits<{ close: []; navigate: [target: Target] }>();
const dialog = ref<HTMLDialogElement>();
const mode = ref('login');
const tab = ref('favorites');
const username = ref('');
const email = ref('');
const password = ref('');
const confirmation = ref('');
const busy = ref(false);
const error = ref('');
const message = ref('');
const favorites = ref<Page<SavedTarget>>({ results: [], count: 0, page: 1, hasNext: false });
const submissions = ref<Page<Submission>>({ results: [], count: 0, page: 1, hasNext: false });
let loadSequence = 0;
const titles: Record<string, string> = { login: '登录档案', register: '建立账号', forgot: '找回密码', resend: '重新验证邮箱', reset: '设置新密码', verify: '验证邮箱' };
const heading = computed(() => user.value ? '我的档案' : titles[mode.value] || '登录档案');
const statusText = { pending: '待审核', approved: '已采纳', rejected: '未采纳' };

async function load(page = 1) {
  if (!user.value || !props.open) return;
  const sequence = ++loadSequence;
  const currentTab = tab.value;
  busy.value = true;
  error.value = '';
  try {
    if (currentTab === 'favorites') {
      const result = await api<Page<SavedTarget>>(`favorites/?page=${page}`);
      if (sequence === loadSequence) favorites.value = result;
    } else if (currentTab === 'submissions') {
      const result = await api<Page<Submission>>(`submissions/?page=${page}`);
      if (sequence === loadSequence) submissions.value = result;
    }
  } catch (reason) { if (sequence === loadSequence) error.value = (reason as Error).message; }
  finally { if (sequence === loadSequence) busy.value = false; }
}

watch(() => props.open, async open => {
  await nextTick();
  if (!open) { dialog.value?.close(); loadSequence++; return; }
  mode.value = props.initialAction || 'login';
  password.value = ''; confirmation.value = ''; message.value = ''; error.value = '';
  if (!dialog.value?.open) dialog.value?.showModal();
  if (!sessionReady.value) await refreshSession();
  if (mode.value === 'verify') await submit();
  else await load();
});
watch(tab, () => load());

async function submit() {
  if (busy.value) return;
  error.value = ''; message.value = '';
  if (['register', 'reset'].includes(mode.value) && password.value !== confirmation.value) { error.value = '两次输入的密码不一致。'; return; }
  busy.value = true;
  try {
    if (!sessionReady.value) await refreshSession();
    if (!sessionReady.value) throw new Error(sessionError.value);
    const result = await api<{ detail?: string; user?: User }>(`auth/${mode.value}/`, 'POST', {
      username: username.value, email: email.value, password: password.value, token: props.token, uid: props.uid
    });
    if (result.user) { user.value = result.user; password.value = ''; tab.value = 'favorites'; }
    else { message.value = result.detail || ''; if (['verify', 'reset', 'register'].includes(mode.value)) mode.value = 'login'; }
  } catch (reason) { error.value = (reason as Error).message; }
  finally { busy.value = false; }
  if (user.value) await load();
}

async function signOut() {
  busy.value = true; error.value = '';
  try { await api('auth/logout/', 'POST', {}); user.value = null; mode.value = 'login'; message.value = '已退出账号。'; }
  catch (reason) { error.value = (reason as Error).message; }
  finally { busy.value = false; }
}

async function removeFavorite(id: number) {
  busy.value = true; error.value = '';
  try { await api('favorites/', 'DELETE', { id }); await load(favorites.value.page); }
  catch (reason) { error.value = (reason as Error).message; }
  finally { busy.value = false; }
}

function switchMode(next: string) { mode.value = next; error.value = ''; message.value = ''; }
</script>

<template>
  <dialog ref="dialog" id="account-dialog" class="archive-dialog account-dialog" aria-labelledby="account-heading" @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close'); }">
    <div class="archive-dialog-surface">
      <header class="archive-dialog-header"><h2 id="account-heading">{{ heading }}</h2><button class="archive-close" aria-label="关闭我的档案" @click="emit('close')"><svg aria-hidden="true"><use href="#i-close" /></svg></button></header>
      <div class="archive-dialog-body">
        <p v-if="error || sessionError" class="archive-feedback error" role="alert">{{ error || sessionError }}</p>
        <p v-if="message" class="archive-feedback" role="status">{{ message }}</p>
        <template v-if="user">
          <div class="account-identity"><strong>{{ user.username }}</strong><span>{{ user.email }}</span></div>
          <nav class="archive-tabs" aria-label="个人档案栏目">
            <button :aria-current="tab === 'favorites' ? 'page' : undefined" @click="tab = 'favorites'">我的收藏</button>
            <button :aria-current="tab === 'submissions' ? 'page' : undefined" @click="tab = 'submissions'">我的补充</button>
            <button :aria-current="tab === 'account' ? 'page' : undefined" @click="tab = 'account'">账号</button>
          </nav>
          <p v-if="busy" class="archive-empty" role="status">正在读取档案…</p>
          <template v-else-if="tab === 'favorites'">
            <p v-if="!favorites.results.length" class="archive-empty">还没有收藏。可在人物或关系档案中点击“收藏这份档案”。</p>
            <ul v-else class="archive-records"><li v-for="item in favorites.results" :key="item.id">
              <button :disabled="!item.available" class="archive-record-link" @click="emit('navigate', item)"><span>{{ item.title }}</span><small>{{ item.targetType === 'person' ? '人物档案' : '关系档案' }}</small></button>
              <button class="archive-text-button" aria-label="取消这条收藏" @click="removeFavorite(item.id)">取消收藏</button>
            </li></ul>
            <div v-if="favorites.count > 30" class="archive-pagination"><button :disabled="favorites.page <= 1" @click="load(favorites.page - 1)">上一页</button><span>{{ favorites.page }}</span><button :disabled="!favorites.hasNext" @click="load(favorites.page + 1)">下一页</button></div>
          </template>
          <template v-else-if="tab === 'submissions'">
            <p v-if="!submissions.results.length" class="archive-empty">你还没有提交补充。发现缺失或不准确的资料时，可以在对应档案中提供说明与来源。</p>
            <ul v-else class="archive-records submissions"><li v-for="item in submissions.results" :key="item.id"><div><span class="archive-state">{{ statusText[item.status] }}</span><button class="archive-record-link" :disabled="!item.available" @click="emit('navigate', item)">{{ item.title }}</button><p>{{ item.body }}</p><p v-if="item.reviewNote" class="archive-muted">审核意见：{{ item.reviewNote }}</p></div></li></ul>
            <div v-if="submissions.count > 30" class="archive-pagination"><button :disabled="submissions.page <= 1" @click="load(submissions.page - 1)">上一页</button><span>{{ submissions.page }}</span><button :disabled="!submissions.hasNext" @click="load(submissions.page + 1)">下一页</button></div>
          </template>
          <div v-else class="archive-account-actions"><p class="archive-muted">收藏与补充记录随账号保存。</p><a v-if="user.isStaff" class="archive-button" href="/admin/" target="_blank" rel="noopener">进入资料管理</a><button class="archive-button secondary" :disabled="busy" @click="signOut">退出登录</button></div>
          <button v-if="error" class="archive-text-button" @click="load()">重新读取</button>
        </template>
        <template v-else>
          <p class="archive-intro">登录后可收藏人物和关系、发表评论或提交资料补充。</p>
          <nav v-if="mode === 'login' || mode === 'register'" class="archive-tabs" aria-label="账号操作"><button :aria-current="mode === 'login' ? 'page' : undefined" @click="switchMode('login')">登录</button><button v-if="registrationEnabled" :aria-current="mode === 'register' ? 'page' : undefined" @click="switchMode('register')">注册</button></nav>
          <form class="archive-form" @submit.prevent="submit">
            <label v-if="mode === 'login' || mode === 'register'">用户名<input v-model="username" name="username" autocomplete="username" maxlength="150" required></label>
            <label v-if="['register', 'forgot', 'resend'].includes(mode)">邮箱<input v-model="email" name="email" type="email" autocomplete="email" maxlength="254" required><small v-if="mode === 'register'">用于账号验证和找回密码。</small></label>
            <label v-if="['login', 'register', 'reset'].includes(mode)">密码<input v-model="password" name="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :minlength="mode === 'login' ? 1 : 10" maxlength="256" required><small v-if="mode !== 'login'">至少 10 位，避免常见密码和纯数字。</small></label>
            <label v-if="['register', 'reset'].includes(mode)">再次输入密码<input v-model="confirmation" type="password" autocomplete="new-password" maxlength="256" required></label>
            <button class="archive-button" :disabled="busy || (mode === 'register' && !registrationEnabled)">{{ busy ? '正在处理…' : mode === 'login' ? '进入我的档案' : mode === 'register' ? '注册并发送验证邮件' : mode === 'reset' ? '更新密码' : mode === 'verify' ? '验证邮箱' : '发送邮件' }}</button>
          </form>
          <div class="account-secondary"><button v-if="mode === 'login'" class="archive-text-button" @click="switchMode('forgot')">忘记密码</button><button v-if="mode === 'login'" class="archive-text-button" @click="switchMode('resend')">重新发送验证邮件</button><button v-else class="archive-text-button" @click="switchMode('login')">返回登录</button></div>
        </template>
      </div>
    </div>
  </dialog>
</template>
