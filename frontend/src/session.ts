import { ref } from 'vue';
import { api } from './api';
import type { User } from './types';

export const user = ref<User | null>(null);
export const sessionReady = ref(false);
export const sessionError = ref('');
export const communityEnabled = ref(false);
export const registrationEnabled = ref(false);
export async function refreshSession() {
  try {
    const session = await api<{ user: User | null; registrationEnabled: boolean; communityEnabled: boolean }>('session/');
    communityEnabled.value = session.communityEnabled === true;
    user.value = communityEnabled.value ? session.user : null;
    registrationEnabled.value = communityEnabled.value && session.registrationEnabled;
    sessionError.value = '';
    sessionReady.value = true;
  } catch (error) { communityEnabled.value = false; registrationEnabled.value = false; user.value = null; sessionError.value = (error as Error).message; sessionReady.value = false; }
}
