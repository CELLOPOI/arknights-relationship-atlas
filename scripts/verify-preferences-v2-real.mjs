import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './playwright.mjs';
import { verificationDirectory } from './verification-output.mjs';
import { siteNotice } from '../frontend/src/content/site-notice.ts';
import { skinDirectoryForms } from '../frontend/src/preferences/skin-directory.ts';

// 真实 HTTP 与真实素材；参与动作是演练数据，必须显式指定可丢弃本地数据库。
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5191';
assert.equal(process.env.PREFERENCES_DISPOSABLE_PREVIEW, '1', 'Requires a separately provisioned disposable preview database');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname));
const catalog = JSON.parse(await readFile(new URL('../data/preferences/catalog.json', import.meta.url)));
const output = await verificationDirectory('preferences-v2-real');
const report = { real_api: true, synthetic_participation: true, disposable_database_required: true, base, viewports: [], navigation: [], started_at: new Date().toISOString() };
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
async function until(test, message) { for (let i=0;i<200;i++) { if (await test()) return; await new Promise(r=>setTimeout(r,50)); } assert.fail(message); }
async function settled(page, selector) { await page.locator(selector).first().waitFor(); await page.waitForFunction(()=>!document.documentElement.dataset.sectionTransitioning && !document.documentElement.dataset.sectionLoading); }
async function noOverflow(page) { assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('dialog[open]')].every(x=>x.scrollWidth<=x.clientWidth+1))); }
async function swipe(page, x, y, dy) {
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=10;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*i/10}]});await page.waitForTimeout(16);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
}
async function tab(page,name){await page.getByRole('navigation',{name:'喜好视图'}).getByRole('button',{name,exact:true}).click();}
try {
  for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:640},{width:844,height:390}]) {
    const mobile=viewport.width<=390 || viewport.height<=390;
    const context=await browser.newContext({viewport,hasTouch:mobile,isMobile:mobile});
    await context.addInitScript(version=>{
      localStorage.setItem('atlas:site-notice:acknowledged',version);
      window.preferenceDirections=[];
      new MutationObserver(()=>{const v=document.documentElement?.dataset.sectionDirection;if(v)window.preferenceDirections.push(v);}).observe(document,{subtree:true,attributes:true,attributeFilter:['data-section-direction']});
    },siteNotice.version);
    const page=await context.newPage(),errors=[],calls=[],failures=[];page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',req=>{if(new URL(req.url()).pathname.startsWith('/api/'))calls.push({path:new URL(req.url()).pathname,method:req.method()});});
    page.on('response',res=>{if(res.status()>=400)failures.push({url:res.url(),status:res.status()});});
    const writes=()=>calls.filter(x=>x.method!=='GET' && x.path!=='/api/preferences/identity/').length;
    const tasks=()=>calls.filter(x=>x.path==='/api/preferences/tasks/').length;
    const state=()=>page.evaluate(async()=>{const r=await fetch('/api/preferences/state/');if(!r.ok)throw Error(`State ${r.status}`);return r.json();});
    try {
      await page.goto(`${base}/preferences/?tab=skins`);await settled(page,'.skin-card');
      await until(async()=>await page.locator('.skin-card .preference-image[data-image-state="ready"]').count()>0,'First portraits load');
      await page.waitForTimeout(800);await noOverflow(page);
      assert.equal(await page.locator('.skin-card').count(),skinDirectoryForms(catalog.forms).length);assert.equal(await page.locator('.skin-profession-group').count(),8);
      assert.equal(writes(),0);assert.equal(tasks(),0);
      const network=await page.evaluate(()=>{const rows=performance.getEntriesByType('resource');return {requests:rows.length,decoded_bytes:rows.reduce((n,r)=>n+r.decodedBodySize,0),transfer_bytes:rows.reduce((n,r)=>n+r.transferSize,0),portraits:rows.filter(r=>r.name.includes('/v2/portrait/')).length,full_appearances:rows.filter(r=>r.name.includes('/v2/full/')).length,catalog_bytes:rows.filter(r=>r.name.includes('/api/preferences/catalog/')).reduce((n,r)=>n+r.decodedBodySize,0)};});
      assert.equal(network.full_appearances,0);assert.ok(network.portraits<catalog.forms.length,'Directory lazily fetches portraits');
      const first=page.locator('.skin-card').first(),firstId=await first.getAttribute('data-form-id');
      assert.equal(await first.getAttribute('data-appearance-id'),catalog.forms.find(x=>x.id===firstId).default_appearance_id);
      if(viewport.width<=390){const a=await first.boundingBox(),b=await page.locator('.skin-profession-group').first().locator('.skin-card').nth(1).boundingBox();assert.ok(Math.abs(a.y-b.y)<2 && b.x>a.x);}
      await page.mouse.move(1,1);await page.waitForTimeout(420);
      assert.match(await first.locator('img').evaluate(x=>getComputedStyle(x).filter),/grayscale\(1\)/);
      await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}-directory.png`)});
      if(!mobile){await first.hover();await page.waitForTimeout(550);assert.match(await first.locator('img').evaluate(x=>getComputedStyle(x).filter),/grayscale\(0\)/);await page.screenshot({path:path.join(output,'desktop-hover.png')});}
      await page.keyboard.press('Tab');await first.focus();await page.waitForTimeout(420);
      assert.equal(await first.evaluate(x=>x.matches(':focus-visible')),true);
      assert.match(await first.locator('img').evaluate(x=>getComputedStyle(x).filter),/grayscale\(0\)/);
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.equal(await first.locator('img').evaluate(x=>getComputedStyle(x).transform),'none');
      if(mobile)await first.tap();else await first.click();
      const dialog=page.locator('.skins-view dialog.preference-detail[open]');await dialog.waitFor();await noOverflow(page);
      assert.equal(writes(),0,'Focus, hover and first tap only open the detail');
      const urlWithDialog=page.url();await dialog.locator('.preference-detail-body').hover();await page.mouse.wheel(0,-500);await page.waitForTimeout(200);assert.equal(page.url(),urlWithDialog,'Dialog wheel does not navigate');
      await dialog.getByRole('button',{name:'返回目录',exact:true}).click();
      await page.getByLabel('搜索干员').fill('缄默德克萨斯');
      const target=catalog.forms.find(x=>x.name==='缄默德克萨斯');const targetCard=page.locator(`[data-form-id="${target.id}"]`);
      await targetCard.click();await dialog.waitFor();
      await until(async()=>await dialog.locator('.choice-option .preference-image[data-image-state="ready"]').count()===target.appearance_ids.length,'Real complete option images');
      const chosen=catalog.appearances.find(x=>x.form_id===target.id && x.kind==='outfit');
      const option=dialog.locator('.choice-option').filter({has:page.getByRole('heading',{name:chosen.name,exact:true})});
      await option.getByRole('button',{name:'选为最爱',exact:true}).click();
      await dialog.getByRole('button',{name:'确认最爱',exact:true}).click();
      await until(async()=> (await state()).choices.some(x=>x.object_id===target.id && x.choice_id===chosen.id),'Real saved choice');
      await dialog.getByRole('button',{name:'返回目录',exact:true}).click();
      await until(async()=>await targetCard.getAttribute('data-appearance-id')===chosen.id,'Personal saved portrait');
      await page.reload();await settled(page,'.skin-card');
      assert.equal(await targetCard.getAttribute('data-appearance-id'),chosen.id);assert.equal(await page.getByLabel('搜索干员').inputValue(),'缄默德克萨斯');
      const saved=(await state()).choices.find(x=>x.object_id===target.id);assert.ok(saved.next_change_at);
      await page.getByLabel('搜索干员').fill('');
      if(!mobile){await page.getByLabel('搜索干员').hover();await page.mouse.wheel(0,-200);await page.waitForTimeout(250);assert.equal(new URL(page.url()).pathname,'/preferences/');}
      await page.locator('.preferences-workspace').evaluate(x=>x.scrollTop=1200);
      const listBox=await page.locator('.preferences-workspace').boundingBox();
      if(mobile)await swipe(page,listBox.x+listBox.width/2,Math.min(listBox.y+listBox.height*.7,viewport.height-50),-100);else{await page.mouse.move(listBox.x+20,listBox.y+100);await page.mouse.wheel(0,200);}
      await page.waitForTimeout(350);assert.equal(new URL(page.url()).pathname,'/preferences/','Long list scroll stays in the page');
      const oldScroll=await page.locator('.preferences-workspace').evaluate(x=>x.scrollTop),oldWrites=writes();
      await page.locator('a.preferences-source').click();await settled(page,'#sources-content');
      await page.locator('nav a[href="/preferences/"]').click();await settled(page,'.characters-view');
      await tab(page,'皮肤');await until(async()=>Math.abs(await page.locator('.preferences-workspace').evaluate(x=>x.scrollTop)-oldScroll)<5,'Scroll restored after unmount');
      assert.equal(writes(),oldWrites);assert.equal(tasks(),0);
      await tab(page,'人物');await page.getByRole('button',{name:'厨力支持',exact:true}).click();
      // 双榜按具体形态展示支持入口，阿米娅的三个职业形态会同时命中搜索。
      await page.getByLabel('搜索人物').fill('阿米娅');await page.locator('.support-directory article').getByRole('button',{name:'加入支持',exact:true}).first().click();
      await page.getByRole('button',{name:'保存整份名单',exact:true}).click();
      await until(async()=>(await state()).supports.support_ids.includes('char_002_amiya'),'Real support saved');
      assert.equal((await state()).supports.subject_support_ids.length,1,'One selected form produces one person support');
      await page.getByRole('button',{name:'随机选择',exact:true}).click();
      await page.getByRole('button',{name:'开始随机选择',exact:true}).click();
      await until(async()=>await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().isEnabled(),'Real random task ready');
      const pending=(await state()).pending_task,quota=(await state()).quota.weekly_used;
      await page.reload();await settled(page,'.random-pair');assert.equal((await state()).pending_task.id,pending.id);assert.equal((await state()).quota.weekly_used,quota);assert.equal(tasks(),1);
      let release;const gate=new Promise(r=>release=r);let answerResponse;
      await page.route('**/api/preferences/tasks/*/answer/',async route=>{answerResponse=await route.fetch();await gate;await route.fulfill({response:answerResponse});});
      await page.getByRole('button',{name:'更喜欢这位',exact:true}).first().click();await until(()=>!!answerResponse,'Server accepted answer');assert.equal(answerResponse.status(),200);
      await page.locator('a.preferences-source').click();await settled(page,'#sources-content');release();await page.waitForTimeout(400);assert.equal(tasks(),1,'Hidden accepted answer does not dispatch');
      await page.unroute('**/api/preferences/tasks/*/answer/');
      await page.locator('nav a[href="/preferences/"]').click();await settled(page,'.characters-view');
      assert.equal((await state()).pending_task,null);assert.equal((await state()).quota.weekly_used,quota);
      await page.getByRole('button',{name:'榜单与趋势',exact:true}).click();await page.getByRole('heading',{name:'近期随机好感 + 当前支持',exact:true}).waitFor();
      await page.getByText('样本积累中',{exact:true}).first().waitFor();await noOverflow(page);
      await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}-results.png`)});
      // 喜好是滑动翻页终点；来源页只通过链接进入，顶部和底部都不翻页。
      const origin=await page.evaluate(()=>performance.timeOrigin);
      await page.locator('.preferences-workspace').evaluate(x=>x.scrollTop=x.scrollHeight);await page.waitForTimeout(250);
      const box=await page.locator('.preferences-workspace').boundingBox();
      if(mobile)await swipe(page,box.x+20,box.y+Math.min(box.height*.7,180),-90);else{await page.mouse.move(box.x+8,box.y+box.height/2);await page.mouse.wheel(0,100);}
      await page.waitForTimeout(300);assert.equal(new URL(page.url()).pathname,'/preferences/');
      await page.locator('a.preferences-source').click();await settled(page,'#sources-content');
      await page.locator('#sources-content').evaluate(x=>x.scrollTop=0);await page.waitForTimeout(250);
      const sourceBox=await page.locator('#sources-content').boundingBox();
      if(mobile)await swipe(page,sourceBox.x+20,sourceBox.y+70,90);else{await page.mouse.move(sourceBox.x+8,sourceBox.y+100);await page.mouse.wheel(0,-100);}
      await page.waitForTimeout(300);assert.equal(new URL(page.url()).pathname,'/sources/');
      await page.locator('nav a[href="/preferences/"]').click();
      await settled(page,'.characters-view');await page.locator('.preferences-workspace').evaluate(x=>x.scrollTop=0);await page.waitForTimeout(250);
      const backBox=await page.locator('.preferences-workspace').boundingBox();
      if(mobile)await swipe(page,backBox.x+20,backBox.y+70,90);else{await page.mouse.move(backBox.x+8,backBox.y+100);await page.mouse.wheel(0,-100);}
      await settled(page,'#game-workspace');await page.goBack();await settled(page,'.characters-view');
      await page.goForward();await settled(page,'#game-workspace');assert.equal(await page.evaluate(()=>performance.timeOrigin),origin);
      const directions=await page.evaluate(()=>window.preferenceDirections);assert.ok(directions.includes('forward')&&directions.includes('backward'));
      assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
      report.viewports.push({viewport,passed:true,network,api_writes:writes(),task_dispatches:tasks(),personal_card_persisted:true,quota_recovered:true,synthetic_answers:1});
      report.navigation.push({viewport,directions,document_reloaded:false,native_touch:mobile});console.log(`PASS real ${viewport.width}x${viewport.height}: complete art, saved state, quotas, boundary navigation`);
    } catch(error){await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}-failure.png`)}).catch(()=>{});report.viewports.push({viewport,passed:false,error:error.message,errors,failures});throw error;}
    finally {await context.close();}
  }
} finally {report.finished_at=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
