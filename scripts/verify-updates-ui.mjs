import assert from 'node:assert/strict';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';

const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5183';
const output = await verificationDirectory('updates');
const browser = await chromium.launch({headless:true});
const errors=[];
// 公开的剧情核查结论用于版式预览；测试不会连接业务数据库或发布说明。
const entries=[
  {id:2,category:'story',status:'published',publishedAt:'2026-09-26T12:00:00Z',title:'修正同名人物关系，补录塔露拉与死芒',summary:'核对同名人物与剧情原文，撤下 8 条误判关系，修正 1 条关系的依据，并补上 1 条遗漏的双向认识。',changes:['医生与博士是不同人物。撤下医生与 W、槐琥、微风、时隙、嘉辛塔、大帝之间因身份误认建立的关系；W 与博士的原有关系保留。','响石的本名是费尔南·伯恩。《空想花庭》中的费尔南是另一位萨卡兹居民，撤下响石与送葬人、莱蒙德的误判关系。','凯尔希与彩虹干员医生的关系保留既有人工裁定，撤除误引的 DM-5 剧情，明确标注“人工裁定，非剧情原文”。','补录塔露拉与死芒的双向认识。死芒即爱布拉娜·都柏林；主线 13-22《灾厄积渐》中，两人直接交手并对话，互相识别身份。'],acknowledgements:'感谢反馈同名人物误认、补充第十三章交手场景，并协助定位剧情出处的玩家。'},
  {id:1,category:'feature',status:'published',publishedAt:'2026-09-26T11:00:00Z',title:'新增更新说明',summary:'剧情修订与功能变化现在有了统一的查看入口。',changes:['通过顶部导航的“更新”进入更新说明，手机端可从导航菜单打开。','按“剧情修订”或“功能更新”筛选记录，查看更早的更新。'],acknowledgements:'感谢大家持续补充剧情线索、提出使用建议。'}
];
async function page(viewport){
  const p=await browser.newPage({viewport,reducedMotion:'reduce'});
  p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>localStorage.setItem('atlas:site-notice:acknowledged','1'));
  await p.route('**/api/updates/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/preview/'))return route.fulfill({json:{...entries[0],status:'draft',publishedAt:null}});
    const category=url.searchParams.get('category')||'all';
    const results=entries.filter(e=>category==='all'||category===e.category);
    return route.fulfill({json:{results,count:results.length,next:null}});
  });
  return p;
}
try{
  for(const [name,viewport] of Object.entries({desktop:{width:1440,height:1100},mobile:{width:390,height:844}})){
    const p=await page(viewport);
    await p.goto(base+'/updates/');
    await p.locator('.update-entry').first().waitFor();
    await p.evaluate(()=>document.fonts.ready);
    assert.equal(await p.locator('.update-entry').count(),2);
    // 旧响应可能仍携带致谢字段，页面也不能再生成固定致谢区块。
    assert.equal(await p.locator('.update-thanks').count(),0);
    assert.doesNotMatch(await p.locator('.updates-footer').innerText(),/感谢/);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.screenshot({path:output+'/'+name+'.png'});
    await p.getByRole('button',{name:'功能更新',exact:true}).click();
    await p.waitForFunction(()=>document.querySelectorAll('.update-entry').length===1);
    assert.match(await p.locator('.update-entry').innerText(),/新增更新说明/);
    assert.ok(p.url().includes('category=feature'));
    await p.goBack();
    await p.waitForFunction(()=>document.querySelectorAll('.update-entry').length===2);
    await p.getByRole('button',{name:'反馈问题',exact:true}).click();
    await p.locator('#feedback-dialog[open]').waitFor();
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#feedback-dialog').isVisible(),false);
    if(name==='mobile'){
      await p.getByRole('button',{name:'打开导航'}).click();
      await p.getByRole('dialog',{name:'网站导航'}).getByRole('link',{name:'UPDATES 更新'}).click();
      assert.equal(await p.getByRole('dialog',{name:'网站导航'}).isVisible(),false);
    }
    await p.goto(base+'/updates/?preview=2');
    await p.locator('.update-entry').waitFor();
    assert.match(await p.locator('.updates-preview').innerText(),/待发布/);
    assert.equal(await p.locator('.update-meta time').count(),0);
    await p.screenshot({path:output+'/'+name+'-preview.png'});
    await p.close();
  }
  const p=await page({width:390,height:844});
  let mode='error';
  await p.route('**/api/updates/**',route=>mode==='error'?route.fulfill({status:503,json:{detail:'暂时无法加载更新说明。'}}):route.fulfill({json:{results:[],count:0,next:null}}));
  await p.goto(base+'/updates/');
  await p.getByRole('alert').waitFor();
  mode='empty';
  await p.getByRole('button',{name:'重新加载'}).click();
  await p.getByRole('heading',{name:'暂无更新记录'}).waitFor();
  assert.equal(await p.getByRole('alert').count(),0);
  await p.close();
  assert.deepEqual(errors,[]);
  console.log('PASS desktop/mobile layout, filters, history, feedback, navigation, draft preview, errors and empty state');
  console.log(output);
}finally{await browser.close();}
