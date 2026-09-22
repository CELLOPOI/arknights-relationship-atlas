import { createApp } from 'vue';
import './styles/graph.css';
import './styles/site.css';
import './styles/community.css';
import './styles/sources.css';

// 游戏独立挂载，避免旧图谱的全局导航与画布监听进入游戏页面。
const entry = /^\/sources\/?$/.test(location.pathname) ? import('./info/SourceNotice.vue')
  : /^\/game\/?$/.test(location.pathname) ? import('./game/GameApp.vue') : import('./App.vue');
entry.then(({ default: App }) => createApp(App).mount('#app'));
