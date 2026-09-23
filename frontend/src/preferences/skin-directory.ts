import type { Form } from './types';

// 游戏中的临时支援实例共用人物与外观身份，不另占皮肤目录入口。
// 只合并已核对的实例；异格、阿米娅职业形态及领主·Sharp 仍独立展示。
// 原始 ID 与旧详情链接保留，避免把已有登记转投给另一个对象。
const supportAliases: Readonly<Record<string, string>> = {
  char_512_aprot: 'char_4025_aprot2',
  char_608_acpion: 'char_513_apionr',
  char_609_acguad: 'char_508_aguard',
  char_611_acnipe: 'char_511_asnipe',
  char_612_accast: 'char_509_acast',
  char_613_acmedc: 'char_510_amedic',
};

export function skinDirectoryForms(forms: readonly Form[]): Form[] {
  const byId = new Map(forms.map(form => [form.id, form]));
  return forms.filter(form => {
    if (!form.default_appearance_id) return false;
    const canonical = byId.get(supportAliases[form.id] || '');
    return !canonical?.eligible || !canonical.complete || !canonical.default_appearance_id
      || canonical.person_id !== form.person_id || canonical.profession !== form.profession;
  });
}
