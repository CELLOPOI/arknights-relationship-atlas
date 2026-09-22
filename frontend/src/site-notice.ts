import { ref } from 'vue';
import { siteNotice } from './content/site-notice';

const storageKey = 'atlas:site-notice:acknowledged';
let rememberedVersion = '';
export const siteNoticeOpen = ref(false);

export function hasAcknowledgedSiteNotice() {
  if (rememberedVersion === siteNotice.version) return true;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { if (window[name].getItem(storageKey) === siteNotice.version) return true; }
    catch { /* 存储被禁用时仍允许完成本次阅读。 */ }
  }
  return false;
}

export function openSiteNotice() { siteNoticeOpen.value = true; }

export function acknowledgeSiteNotice() {
  rememberedVersion = siteNotice.version;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { window[name].setItem(storageKey, siteNotice.version); }
    catch { /* 持久存储不可用时尝试会话存储，最后保留当前页面内的确认状态。 */ }
  }
  siteNoticeOpen.value = false;
}
