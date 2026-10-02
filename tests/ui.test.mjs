import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=fileURLToPath(new URL('../evidence/',import.meta.url));
const url='http://127.0.0.1:14173';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Browser plugin is not available in this task. Use isolated Playwright + Chromium.
// This test starts the app and browser in the same executor invocation.
test('真实 EVM 教学页面：桌面、移动端、重复点击、输入校验、篡改、断连恢复', {timeout:120000}, async()=>{
  mkdirSync(evidence,{recursive:true});
  let output='';
  const env={...process.env,HARDHAT_DISABLE_TELEMETRY:'true',APP_PORT:'14173',CHAIN_PORT:'18545'};
  const startChain=()=>{const p=spawn(process.execPath,['node_modules/hardhat/dist/src/cli.js','node','--hostname','127.0.0.1','--port','18545','--network','localDemo'],{cwd:root,env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',()=>{});p.stderr.on('data',()=>{});return p;};
  let chain=startChain();
  const app=spawn(process.execPath,['server/index.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',d=>output+=d);app.stderr.on('data',d=>output+=d);
  let browser;
  const proof={executedAt:new Date().toISOString(),node:process.version,browserPath:null,checks:[],receipts:[]};
  function passed(name){proof.checks.push({name,status:'passed'});}
  try{
    let ready=false;
    for(let i=0;i<120;i++){try{if((await (await fetch(url+'/api/state')).json()).connected){ready=true;break;}}catch{}if(app.exitCode!==null)break;await sleep(150);}
    assert.ok(ready,output);
    const executable=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
    proof.browserPath=executable||'Playwright-managed Chromium';
    browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox',...(process.env.CHROMIUM_EXTRA_ARGS?JSON.parse(process.env.CHROMIUM_EXTRA_ARGS):[])]});
    const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);assert.equal(await page.title(),'链上第一步 · 本地区块链学习实验');
    await page.locator('#connection.online').waitFor();
    assert.ok(await page.locator('h1').isVisible());assert.equal(await page.locator('#write').isDisabled(),true);
    assert.equal(await page.locator('#receipt-empty').isVisible(),true);
    assert.equal((await page.locator('body').innerText()).includes('Error overlay'),false);
    passed('页面标题、非空、无框架错误，部署前写入被禁用，无伪造回执');
    const before=await (await fetch(url+'/api/state')).json();
    await page.locator('#hash').click();await page.waitForFunction(()=>document.querySelector('#digest').textContent.startsWith('0x'));
    assert.match(await page.locator('#digest').textContent(),/^0x[0-9a-f]{64}$/);
    assert.equal((await (await fetch(url+'/api/state')).json()).blockNumber,before.blockNumber);
    passed('浏览器真实生成SHA-256，不发交易、不增加区块');
    await page.locator('#deploy').click();await page.waitForFunction(()=>document.querySelector('#deploy').textContent.includes('已部署'));
    assert.equal(await page.locator('#deploy').isDisabled(),true);assert.equal(await page.locator('#write').isEnabled(),true);
    passed('真实部署合约，显示已确认回执，重复部署按钮禁用');
    await page.locator('#original').fill('  \n ');await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('不能只有空格'));
    await page.locator('#original').fill('a'.repeat(1001));await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('超过'));
    assert.equal((await (await fetch(url+'/api/state')).json()).records.length,0);
    passed('空白与1001字符输入给出中文错误，不产生记录');
    const original='我今天开始学习区块链。\n保留空格 🧪';
    await page.locator('#original').fill(original);await page.locator('#write').click({clickCount:2});
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('写入成功'));
    const afterWrite=await (await fetch(url+'/api/state')).json();assert.equal(afterWrite.records.length,1);proof.receipts.push(afterWrite.records[0]);
    await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#write').disabled===false);
    const afterRetry=await (await fetch(url+'/api/state')).json();assert.equal(afterRetry.records.length,1);assert.equal(afterWrite.records[0].transactionHash,afterRetry.records[0].transactionHash);
    passed('真实交易写入Unicode文本摘要；双击与同一请求重试不重复写入');
    await page.locator('#verify').click();await page.locator('#comparison.match').waitFor();
    assert.match(await page.locator('#comparison').textContent(),/不能证明内容真实/);
    await page.screenshot({path:evidence+'desktop-confirmed.png',fullPage:true});
    passed('从合约真实回读，原文验证一致，展示真实性边界');
    await page.locator('#tamper').click();assert.equal(await page.locator('#comparison.match').count(),0);
    await page.locator('#verify').click();await page.locator('#comparison.mismatch').waitFor();
    await page.screenshot({path:evidence+'desktop-tampered.png',fullPage:true});
    passed('修改一个字立即使旧结果失效，重新回读后不一致');
    await page.locator('#original').fill('<img src=x onerror="window.__bad=1">');await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('写入成功'));
    assert.equal(await page.evaluate(()=>window.__bad),undefined);await page.locator('#verify').click();await page.locator('#comparison.match').waitFor();
    passed('HTML样式输入作为纯文本，不执行脚本');
    await page.route('**/api/**',route=>route.abort('connectionrefused'));
    await page.locator('#connection.offline').waitFor({timeout:10000});assert.equal(await page.locator('#write').isDisabled(),true);assert.equal(await page.locator('#verify').isDisabled(),true);
    assert.match(await page.locator('#notice').textContent(),/无法连接|断开/);
    await page.unroute('**/api/**');await page.locator('#connection.online').waitFor({timeout:10000});assert.equal(await page.locator('#write').isEnabled(),true);
    passed('模拟HTTP传输断开：诚实错误、禁用操作、恢复连接可继续（真实节点断开另由后端测试覆盖）');
    await page.reload();await page.locator('#connection.online').waitFor();assert.equal(await page.locator('#record-select option').count(),2);assert.equal(await page.locator('#candidate').inputValue(),'');
    passed('刷新页面保留链上记录而不恢复原文');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#original').fill('在手机尺寸里，也能验证一段文字。');await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('写入成功'));await page.locator('#verify').click();await page.locator('#comparison.match').waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:evidence+'mobile-confirmed.png',fullPage:true});
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:evidence+'mobile-first-screen.png'});
    passed('390×844移动布局无横向溢出；完整写入与验证可操作');
    await new Promise(resolve=>{chain.once('exit',resolve);chain.kill('SIGTERM');});
    await page.locator('#connection.offline').waitFor({timeout:12000});
    assert.equal(await page.locator('#comparison.match').count(),0);
    chain=startChain();
    await page.locator('#connection.online').waitFor({timeout:12000});
    await page.waitForFunction(()=>document.querySelector('#contract').textContent==='尚未部署');
    assert.equal(await page.locator('#receipt-fields').isVisible(),false);
    assert.equal(await page.locator('#comparison.match').count(),0);
    assert.equal(await page.locator('#write').isDisabled(),true);
    assert.equal(await page.locator('#deploy').isEnabled(),true);
    await page.locator('#deploy').click();await page.waitForFunction(()=>document.querySelector('#deploy').textContent.includes('已部署'));
    await page.locator('#write').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('写入成功'));
    assert.equal((await (await fetch(url+'/api/state')).json()).records.length,1);
    passed('真实停链→断连→启动新链：清除旧成功验证与回执，重新部署和写入成功');
    assert.deepEqual(errors,[]);passed('所有页面交互无未捕获JavaScript错误');
    proof.status='passed';proof.finalRecordCount=(await (await fetch(url+'/api/state')).json()).records.length;
  }catch(error){proof.status='failed';proof.error=String(error);throw error;}
  finally{writeFileSync(evidence+'ui-results.json',JSON.stringify(proof,null,2));await browser?.close();chain.kill('SIGTERM');app.kill('SIGTERM');await Promise.race([new Promise(r=>app.once('exit',r)),sleep(4000)]);if(app.exitCode===null)app.kill('SIGKILL');if(chain.exitCode===null)chain.kill('SIGKILL');}
});
