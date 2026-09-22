<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { api, ApiError } from '../api';
import type { FeedbackTarget } from '../types';

const props = defineProps<{ open: boolean; target?: FeedbackTarget | null; initialType?: 'data_error' | 'source' | 'site_issue' | 'other' }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const result = ref<HTMLElement>();
const target = ref<FeedbackTarget | null>(null);
const type = ref(props.initialType || 'data_error');
const description = ref('');
const sourceUrl = ref('');
const contact = ref('');
const website = ref('');
const busy = ref(false);
const success = ref(false);
const error = ref('');
const issuesUrl = 'https://github.com/CELLOPOI/arknights-relationship-atlas/issues';
watch(() => props.open, async open => {
  await nextTick();
  if (!open) { dialog.value?.close(); return; }
  if (success.value) { description.value = ''; sourceUrl.value = ''; contact.value = ''; success.value = false; }
  if (!busy.value) target.value = props.target ? { ...props.target } : null;
  error.value = '';
  dialog.value?.showModal();
});
async function submit() {
  if (busy.value || success.value || !description.value.trim()) return;
  busy.value = true; error.value = '';
  try {
    // 每次重试刷新 CSRF，支持网络恢复和会话 cookie 更新。
    await api('session/');
    await api('feedback/', 'POST', {
      type: type.value, description: description.value.trim(), sourceUrl: sourceUrl.value.trim(),
      contact: contact.value.trim(), website: website.value,
      ...(target.value ? { targetType: target.value.targetType, targetId: target.value.targetId } : {}),
    });
    success.value = true;
  } catch (reason) {
    error.value = reason instanceof ApiError && reason.status === 429
      ? `提交过于频繁，请${reason.retryAfter ? `在 ${reason.retryAfter} 秒后` : '稍后'}重试。已保留填写内容。`
      : `${(reason as Error).message} 已保留填写内容，请检查后重试。`;
  } finally { busy.value = false; await nextTick(); result.value?.focus(); }
}
</script>

<template>
  <dialog ref="dialog" id="feedback-dialog" class="archive-dialog feedback-dialog" aria-labelledby="feedback-heading" @cancel.prevent="emit('close')">
    <div class="archive-dialog-surface">
      <header class="archive-dialog-header"><h2 id="feedback-heading">反馈问题</h2><button class="archive-close" aria-label="关闭反馈" @click="emit('close')"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button></header>
      <div class="archive-dialog-body">
        <p class="archive-intro">优先使用 <a class="archive-text-button" :href="issuesUrl" target="_blank" rel="noopener noreferrer">GitHub Issues（公开）</a>，便于跟进处理进度。也可填写下方表单，无需注册。</p>
        <template v-if="success"><p ref="result" tabindex="-1" role="status" class="archive-feedback">反馈已收到，维护者会核查。</p><p class="archive-muted">反馈存入私有待处理列表，不会自动公开或修改正式资料。</p><button class="archive-button" @click="emit('close')">完成</button></template>
        <form v-else class="archive-form" :aria-busy="busy" @submit.prevent="submit">
          <p class="feedback-privacy">表单内容仅供维护者处理，不公开展示。联系方式为选填，仅用于跟进本次反馈，90 天后清除；反馈在一年后删除。</p>
          <div v-if="target" class="feedback-target"><span>反馈对象：{{ target.targetType === 'person' ? '人物' : '关系' }} · {{ target.title || target.targetId }}</span><button type="button" class="archive-text-button" :disabled="busy" @click="target = null">移除对象</button></div>
          <label for="feedback-type">问题类型<select id="feedback-type" v-model="type" :disabled="busy"><option value="data_error">资料纠错</option><option value="source">原文与来源</option><option value="addition">补充资料</option><option value="site_issue">网站问题</option><option value="other">其他</option></select></label>
          <label for="feedback-description">问题说明（必填）<textarea id="feedback-description" v-model="description" :disabled="busy" rows="5" maxlength="6000" required placeholder="请说明问题所在、建议修改内容，以及可定位的原文或复现步骤。" /><small>最多 6000 字</small></label>
          <label for="feedback-source">来源链接（选填）<input id="feedback-source" v-model="sourceUrl" :disabled="busy" type="url" pattern="https?://.*" maxlength="1500" placeholder="https://…" /><small>支持 http 或 https 链接</small></label>
          <label for="feedback-contact">联系方式（选填）<input id="feedback-contact" v-model="contact" :disabled="busy" maxlength="254" autocomplete="off" /><small>例如邮箱；不填写也可提交。</small></label>
          <div class="feedback-honeypot" aria-hidden="true"><label>Website<input v-model="website" tabindex="-1" autocomplete="off" name="website" /></label></div>
          <p v-if="error" ref="result" tabindex="-1" class="archive-feedback error" role="alert">{{ error }}</p>
          <button class="archive-button" type="submit" :disabled="busy || !description.trim()">{{ busy ? '正在提交…' : '提交反馈' }}</button>
        </form>
      </div>
    </div>
  </dialog>
</template>
