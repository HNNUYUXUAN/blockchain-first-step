const $ = (id) => document.getElementById(id);
const state = { connected: false, contractAddress: null, records: [], deployment: null };
let busy = false;
let latestReceipt = null;
let pendingWrite = null;
let verifyRevision = 0;
let lastKnownContract = null;
let lastDeploymentHash = null;
let hadConnectionLoss = false;

function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = false;
}
function count(value) { return Array.from(value).length; }
function validate(text) {
  if (!text.trim()) throw new Error('请先输入一些文字，不能只有空格或换行');
  if (count(text) > 1000) throw new Error('文字超过 1,000 个字符，请缩短后再试');
}
async function digest(text) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return '0x' + Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type':'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务没有返回可读取的数据，请确认程序仍在运行'); }
  if (!response.ok) throw new Error(data.message || '请求没有完成，请检查本地节点');
  return data;
}
function friendly(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '等待节点超时。请先刷新连接检查链上结果，再重试；同一请求会避免重复写入';
  if (error instanceof TypeError) return '无法连接本地服务。请确认终端中的 npm start 仍在运行，再刷新页面';
  return error.message || '操作未完成，请重新连接后再试';
}
function syncControls() {
  $('deploy').disabled = busy || !state.connected || !!state.contractAddress;
  $('deploy').textContent = state.contractAddress ? '学习合约已部署 ✓' : '部署学习合约';
  $('write').disabled = busy || !state.connected || !state.contractAddress;
  $('hash').disabled = busy;
  const hasRecords = state.records.length > 0;
  $('record-select').disabled = busy || !hasRecords || !state.connected;
  $('candidate').disabled = busy || !hasRecords;
  $('original').disabled = busy;
  $('verify').disabled = busy || !hasRecords || !state.connected;
  $('tamper').disabled = busy || !hasRecords;
}
function progress(step) {
  document.querySelectorAll('[data-step]').forEach(el => {
    const n = Number(el.dataset.step);
    el.className = n < step ? 'done' : n === step ? 'active' : '';
    if(n === step) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
}
function setComparison(kind, title, text, hashes) {
  const box = $('comparison');
  box.className = `comparison ${kind}`;
  box.replaceChildren();
  const symbol = document.createElement('span');symbol.className='result-symbol';symbol.setAttribute('aria-hidden','true');symbol.textContent=kind==='match'?'✓':kind==='mismatch'?'≠':'?';
  const heading=document.createElement('h3');heading.textContent=title;
  const paragraph=document.createElement('p');paragraph.textContent=text;
  box.append(symbol,heading,paragraph);
  if(hashes) Object.entries(hashes).forEach(([label,value])=>{const el=document.createElement('code');el.textContent=label+'\n'+value;box.append(el);});
}
function row(label, value, success=false) {
  const div=document.createElement('div');const dt=document.createElement('dt');const dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value??'—');if(success)dd.className='confirmed';div.append(dt,dd);return div;
}
function showReceipt(receipt, label) {
  if(!receipt)return;
  latestReceipt={kind:label,...receipt};
  $('receipt-empty').hidden=true;$('receipt-fields').hidden=false;$('raw-details').hidden=false;
  $('receipt-fields').replaceChildren(row('操作',label),row('状态',receipt.status==='confirmed'?'成功，已收录':receipt.status,receipt.status==='confirmed'),row('交易哈希',receipt.transactionHash??receipt.hash),row('所在区块','#'+receipt.blockNumber),row('Gas 使用量',receipt.gasUsed));
  $('raw-receipt').textContent=JSON.stringify(latestReceipt,null,2);
}
function updateRecords(records) {
  const previous=$('record-select').value;
  const currentIds=Array.from($('record-select').options).map(o=>o.value).join(',');
  const nextIds=records.map(r=>String(r.id)).join(',');
  if(currentIds!==nextIds){
    $('record-select').replaceChildren();
    if(!records.length){const o=document.createElement('option');o.value='';o.textContent='先写入第一条记录';$('record-select').append(o);}
    records.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=`记录 #${r.id} · 区块 #${r.blockNumber} · ${r.digest.slice(0,12)}…`;$('record-select').append(o);});
    $('record-select').value=records.some(r=>String(r.id)===previous)?previous:String(records.at(-1)?.id??'');
  }
}
async function refresh() {
  try {
    const data=await api('/api/state');
    const wasAddress=lastKnownContract;
    Object.assign(state,data);
    $('connection').textContent=data.connected?'节点已连接':'节点已断开';
    $('connection').className='connection '+(data.connected?'online':'offline');
    $('account').textContent=data.account||'无法读取账户';
    $('chain-id').textContent=data.chainId??'—';
    $('block').textContent=data.blockNumber===null||data.blockNumber===undefined?'—':'# '+data.blockNumber;
    $('balance').textContent=data.balanceEth?`${Number(data.balanceEth).toFixed(4)} 测试 ETH`:'—';
    $('contract').textContent=data.contractAddress||'尚未部署';
    state.records=data.records||[];updateRecords(state.records);
    if(!data.connected){hadConnectionLoss=true;setComparison('','连接已断开，无法确认当前状态','之前的结果不能代表现在的链。恢复连接后请重新验证');notify('本地节点已断开。所有链上操作已暂停，请检查运行 npm start 的终端',true);}
    if(data.connected&&wasAddress&&(!data.contractAddress||data.contractAddress!==wasAddress||(lastDeploymentHash&&lastDeploymentHash!==data.deployment?.blockHash))){latestReceipt=null;pendingWrite=null;$('receipt-empty').hidden=false;$('receipt-fields').hidden=true;$('raw-details').hidden=true;setComparison('','学习链已重置','请重新部署合约并写入，旧记录不属于现在这条链');notify('检测到学习链已重置，需要重新部署合约',true);}
    if(data.connected){lastKnownContract=data.contractAddress;lastDeploymentHash=data.deployment?.blockHash??null;if(hadConnectionLoss){hadConnectionLoss=false;if(data.contractAddress)notify('连接已恢复，请重新回读验证当前链上的记录');}}
    if(!latestReceipt&&data.deployment)showReceipt(data.deployment,'部署合约');
    progress(state.records.length?4:state.contractAddress?3:1);
  } catch(error) {
    state.connected=false;hadConnectionLoss=true;setComparison('','连接已断开，无法确认当前状态','请先恢复本地服务，再重新回读验证');$('connection').textContent='服务未连接';$('connection').className='connection offline';notify(friendly(error),true);
  }
  syncControls();
}
async function act(button, pendingText, operation) {
  if(busy)return;
  busy=true;syncControls();const original=button.textContent;button.textContent=pendingText;notify(pendingText);
  try { await operation(); }
  catch(error) {notify(friendly(error),true);}
  finally {button.textContent=original;busy=false;await refresh();syncControls();}
}
$('hash').addEventListener('click',()=>act($('hash'),'计算中…',async()=>{
  validate($('original').value);$('digest').textContent=await digest($('original').value);notify('摘要已在浏览器中生成。这一步还没有发出交易，也没有写入区块链');
}));
$('deploy').addEventListener('click',()=>act($('deploy'),'部署交易确认中…',async()=>{
  progress(2);const data=await api('/api/deploy',{});state.contractAddress=data.contractAddress;showReceipt(data.deployment,'部署合约');notify('合约部署成功，第一笔交易已被本地区块收录。现在可以写入文字摘要');
}));
$('write').addEventListener('click',()=>act($('write'),'写入交易确认中…',async()=>{
  const text=$('original').value;validate(text);
  const hash=await digest(text);$('digest').textContent=hash;
  if(!pendingWrite||pendingWrite.text!==text)pendingWrite={text,idempotencyKey:crypto.randomUUID()};
  const data=await api('/api/records',pendingWrite);
  if(data.record.digest.toLowerCase()!==hash.toLowerCase())throw new Error('节点返回的摘要与浏览器计算不一致，请停止操作并检查代码');
  showReceipt({...data.receipt,...data.record},`写入记录 #${data.record.id}`);
  await refresh();$('record-select').value=String(data.record.id);$('candidate').value=text;
  setComparison('','已经写入，等你验证','点击「从链上读取并验证」，重新向合约读取摘要');
  notify(`记录 #${data.record.id} 写入成功，交易已收录在区块 #${data.record.blockNumber}。接着用同一段文字验证`);
}));
function invalidateComparison() { verifyRevision++;setComparison('','文字已改变，请重新验证','当前显示不再沿用上一次结果。点击验证会重新读取链上摘要'); }
$('original').addEventListener('input',()=>{$('original-count').textContent=`${count($('original').value)} / 1000`;$('digest').textContent='文字已改变，请重新生成摘要';pendingWrite=null;});
$('candidate').addEventListener('input',invalidateComparison);
$('record-select').addEventListener('change',invalidateComparison);
$('tamper').addEventListener('click',()=>{$('candidate').value+='！';invalidateComparison();$('candidate').focus();});
$('verify').addEventListener('click',()=>act($('verify'),'正在从链上回读…',async()=>{
  const text=$('candidate').value;validate(text);const revision=verifyRevision;
  const result=await api('/api/verify',{id:Number($('record-select').value),text});
  const calculated=await digest(text);if(result.digest.toLowerCase()!==calculated.toLowerCase())throw new Error('浏览器与服务的摘要计算不一致，请检查代码');
  if(revision!==verifyRevision)return;
  setComparison(result.match?'match':'mismatch',result.match?'一致：这段文字没有变化':'不一致：文字变了，摘要也变了',result.match?'现在的文字摘要与合约记录相同。这只说明内容一致，不能证明内容真实。':'合约里的原摘要仍然保留。你改了文字，链上记录不会跟着修改。',{'本次文字摘要':result.digest,'链上记录摘要':result.storedDigest});
  notify(result.match?'回读验证完成：摘要一致':'回读验证完成：摘要不一致，成功发现文字变化');
}));
$('download').addEventListener('click',()=>{if(!latestReceipt)return;const blob=new Blob([JSON.stringify(latestReceipt,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='blockchain-first-step-receipt.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('original-count').textContent=`${count($('original').value)} / 1000`;
await refresh();
setInterval(()=>{if(!busy)refresh();},5000);
