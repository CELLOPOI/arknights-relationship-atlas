<script setup lang="ts">
import { onMounted, ref } from 'vue';
import FeedbackPanel from '../components/FeedbackPanel.vue';
import SiteNotice from '../components/SiteNotice.vue';
import SiteNoticeButton from '../components/SiteNoticeButton.vue';
import mitLicense from '../../../LICENSE?raw';
import './sources.css';

const feedbackOpen = ref(false);
onMounted(() => { document.title = '来源与版权 · 干员关系档案'; });
</script>

<template>
  <div class="sources-page">
    <a class="skip-link" href="#sources-content">跳到来源与版权说明</a>
    <header class="site-header sources-header">
      <a class="site-brand" href="/#home"><span>干员关系档案</span><small>ARKNIGHTS</small></a>
      <nav class="sources-navigation" aria-label="主导航"><a href="/?scope=all#factions">人物关系</a><a href="/game/">六步连线</a></nav>
    </header>
    <main id="sources-content" tabindex="-1" class="sources-content">
      <h1>来源与版权</h1>
      <p class="sources-intro">本站是非官方玩家资料工具，用于整理《明日方舟》人物关系及相关出处，与鹰角网络及相关权利人无官方隶属关系，不代表官方授权或背书。</p>

      <section aria-labelledby="artwork-heading">
        <h2 id="artwork-heading">游戏资料与美术</h2>
        <p>游戏图片、标识、角色设计及引用原文的权利归各自权利人所有；联动内容的权利归相应权利人所有。本站的关系整理与游戏玩法不改变这些内容的权利归属。</p>
        <ul>
          <li>干员头像与立绘：<a href="https://github.com/yuanyan3060/ArknightsGameResource" target="_blank" rel="noopener noreferrer">ArknightsGameResource</a>、<a href="https://github.com/fexli/ArknightsResource" target="_blank" rel="noopener noreferrer">ArknightsResource</a>。</li>
          <li>NPC 图片与阵营徽记：<a href="https://prts.wiki/" target="_blank" rel="noopener noreferrer">PRTS</a>。部分图片经过裁切与压缩；人物档案中提供对应头像来源。</li>
          <li>关系依据：游戏剧情、人物档案及相关资料。引用原文和具体出处随关系详情列出。</li>
        </ul>
        <p>这些链接用于说明取得渠道，不代表来源站向本站授予素材使用权。游戏素材的网站使用依据仍在核对中。</p>
      </section>

      <section aria-labelledby="code-license-heading">
        <h2 id="code-license-heading">代码许可与素材范围</h2>
        <p>本站原创代码采用 MIT 许可证。第三方依赖遵循各自许可；游戏图片、字体、商标、引用原文及其他第三方内容不在原创代码的 MIT 授权范围内。</p>
        <p>页面所用 Vue 运行模块与 Vite 预加载辅助代码的完整声明见 <a href="/assets/licenses/frontend-dependencies.txt" target="_blank" rel="noopener noreferrer">前端依赖许可</a>。</p>
        <p>本站不提供游戏素材整包下载或批量原图导出。页面展示和来源标注不向访问者授予素材再利用或再分发许可。</p>
        <details class="sources-license"><summary>查看原创代码的 MIT 许可全文</summary><pre>{{ mitLicense }}</pre></details>
      </section>

      <section aria-labelledby="fonts-heading">
        <h2 id="fonts-heading">字体</h2>
        <ul>
          <li><strong>Novecento Sans Wide Bold</strong>：Synthview Type Design 出品，使用已取得的官方 Webfont 及网页许可。该字体不随本站原创代码的 MIT 许可授权。</li>
          <li><strong>Relationship Atlas CJK</strong>：由思源黑体 Regular / Bold 子集改名而来，保留原作者版权及 <a href="/assets/licenses/SourceHanSans-OFL.txt" target="_blank" rel="noopener noreferrer">SIL Open Font License 1.1</a>。</li>
          <li><strong>Relationship Atlas Narrow</strong>：由 Oswald Medium 子集改名而来，保留原作者版权及 <a href="/assets/licenses/Oswald-OFL.txt" target="_blank" rel="noopener noreferrer">SIL Open Font License 1.1</a>。两类改名字体的字形没有改变。</li>
          <li><strong>Bender Bold</strong>：TypeType 出品，当前文件的网页使用依据仍在核对中。</li>
        </ul>
      </section>

      <section aria-labelledby="rights-feedback-heading">
        <h2 id="rights-feedback-heading">来源纠错与权利问题</h2>
        <p>如需更正来源、归属，或认为具体内容涉及您的权利，请提供相关页面地址、内容位置与说明。可选填联系方式，便于维护者核查和回复。</p>
        <p>下方表单无需注册，内容进入维护者的私有待处理列表，不会自动公开到 GitHub Issues。具体信息用途与保留期限在表单中说明。</p>
        <button class="archive-button" aria-haspopup="dialog" @click="feedbackOpen = true">反馈来源或版权问题</button>
      </section>
      <footer class="sources-footer"><a href="/#home">返回首页</a><SiteNoticeButton /><span>明日方舟人物关系资料 · 非官方</span></footer>
    </main>
    <FeedbackPanel :open="feedbackOpen" initial-type="source" @close="feedbackOpen = false" />
    <SiteNotice />
  </div>
</template>
