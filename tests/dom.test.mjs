import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function waitFor(fn,message){for(let i=0;i<200;i++){try{if(await fn())return;}catch{}await sleep(75);}throw new Error(message);}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}

test('DOM逻辑 + 真实EVM：完整教学流程、重复点击、篡改、真实停链重启恢复（不验证渲染）',{timeout:60000},async()=>{
 const report={runnerClock:new Date().toISOString(),node:process.version,type:'jsdom DOM + actual local Hardhat EVM; not a rendered browser',checks:[]};
 const appPort=await freePort();let chainPort;do{chainPort=await freePort();}while(chainPort===appPort);
 const base=`http://127.0.0.1:${appPort}`;
 const env={...process.env,HARDHAT_DISABLE_TELEMETRY:'true',APP_PORT:String(appPort),CHAIN_PORT:String(chainPort)};
 const spawnNode=args=>{const p=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',()=>{});p.stderr.on('data',()=>{});return p;};
 const startChain=()=>spawnNode(['node_modules/hardhat/dist/src/cli.js','node','--hostname','127.0.0.1','--port',String(chainPort),'--network','localDemo']);
 let chain=startChain();const api=spawnNode(['server/index.mjs']);let dom;
 const state=async()=>await(await fetch(base+'/api/state')).json();
 const passed=name=>report.checks.push({name,status:'passed'});
 try{
  await waitFor(async()=>(await state()).connected,'链启动失败');
  dom=new JSDOM(readFileSync(root+'public/index.html','utf8'),{url:base,runScripts:'outside-only'});
  const w=dom.window;Object.defineProperty(w,'crypto',{value:webcrypto});w.TextEncoder=TextEncoder;w.AbortSignal=AbortSignal;
  w.fetch=(url,opts)=>fetch(new URL(url,base),opts);
  // Speed up only periodic health polling; actual requests and EVM execution remain real.
  const realInterval=w.setInterval.bind(w);w.setInterval=(fn,ms)=>realInterval(fn,Math.min(ms,150));
  await w.eval('(async()=>{'+readFileSync(root+'public/app.js','utf8')+'})()');
  const $=id=>w.document.getElementById(id);
  const text=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('input',{bubbles:true}));};
  const click=async(id,condition)=>{$(id).click();await waitFor(()=>condition()&&!$('hash').disabled,'操作未完成: '+id);};
  assert.equal(w.document.title,'链上第一步 · 本地区块链学习实验');assert.equal($('write').disabled,true);assert.equal($('receipt-fields').hidden,true);passed('初始禁用写入，显示实际账户，不伪造回执');
  const initial=await state();await click('hash',()=>$('digest').textContent.startsWith('0x'));assert.equal((await state()).blockNumber,initial.blockNumber);passed('SHA-256计算不发交易');
  await click('deploy',()=>$('deploy').textContent.includes('已部署'));assert.equal($('deploy').disabled,true);assert.equal($('write').disabled,false);passed('真实部署，页面显示成功回执');
  text('original',' \n ');await click('write',()=>$('notice').textContent.includes('不能只有空格'));
  text('original','a'.repeat(1001));await click('write',()=>$('notice').textContent.includes('超过'));assert.equal((await state()).records.length,0);passed('空白与过长输入被拒绝，不发交易');
  const original='我今天开始学习区块链。\n保留空格 🧪';text('original',original);$('write').click();$('write').click();await waitFor(()=>$('notice').textContent.includes('写入成功')&&!$('write').disabled,'写入失败');
  const first=(await state()).records[0];assert.ok(first);await click('write',()=>$('notice').textContent.includes('写入成功'));assert.equal((await state()).records.length,1);report.actualRecord=first;passed('双击与同一请求重试只生成一笔真实写交易');
  await click('verify',()=>$('comparison').classList.contains('match'));assert.ok($('comparison').textContent.includes('不能证明内容真实'));passed('真实回读一致，页面呈现真实性边界');
  $('tamper').click();assert.equal($('comparison').classList.contains('match'),false);await click('verify',()=>$('comparison').classList.contains('mismatch'));passed('改一个字使旧结果立即失效，真实回读不一致');
  text('candidate',original);await click('verify',()=>$('comparison').classList.contains('match'));
  await stop(chain);await waitFor(()=>$('connection').classList.contains('offline'),'页面未显示断链');assert.equal($('comparison').classList.contains('match'),false);assert.equal($('write').disabled,true);passed('真实停链后立即取消成功验证，禁用链上操作');
  chain=startChain();await waitFor(()=>$('connection').classList.contains('online')&&$('contract').textContent==='尚未部署','重启链未清空界面');
  assert.equal($('receipt-fields').hidden,true);assert.equal($('raw-details').hidden,true);assert.equal($('write').disabled,true);assert.equal($('deploy').disabled,false);passed('新链连接后清空旧回执、旧合约与幂等请求');
  await click('deploy',()=>$('deploy').textContent.includes('已部署'));await click('write',()=>$('notice').textContent.includes('写入成功'));assert.equal((await state()).records.length,1);await click('verify',()=>$('comparison').classList.contains('match'));passed('新链重新部署、写入、验证完整成功');
  text('original','<img src=x onerror="window.__bad=1">');await click('write',()=>$('notice').textContent.includes('写入成功'));assert.equal(w.__bad,undefined);assert.equal(w.document.querySelectorAll('img').length,0);passed('HTML字符串作为纯文本，不插入危险元素');
  report.status='passed';
 }catch(error){report.status='failed';report.error=String(error);throw error;}
 finally{dom?.window.close();await stop(api);await stop(chain);mkdirSync(root+'evidence',{recursive:true});writeFileSync(root+'evidence/dom-results.json',JSON.stringify(report,null,2)+'\n');}
});
