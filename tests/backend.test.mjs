import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider } from 'ethers';
import { compileContract } from '../server/compile.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
let appPort, chainPort, base, rpcUrl, api, chain, provider, contractAddress, firstRecord;
const children = new Set();
async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function spawnNode(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: 'true', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  // Consume logs without saving the development node's publicly-known keys.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('exit', () => children.delete(child));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref())]);
}
async function waitFor(fn, child) {
  let failure;
  for (let n = 0; n < 100; n++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Child exited with ${child.exitCode}`);
    try { if (await fn()) return; } catch (error) { failure = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw failure || new Error('Local service was not ready within 10 seconds');
}
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(2000) });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
async function request(route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function startChain() {
  chain = spawnNode(['node_modules/hardhat/dist/src/cli.js', 'node', '--hostname', '127.0.0.1', '--port', String(chainPort), '--network', 'localDemo']);
  await waitFor(async () => Number(await rpc('eth_chainId')) === 31337, chain);
}
before(async () => {
  appPort = await unusedPort();
  do { chainPort = await unusedPort(); } while (chainPort === appPort);
  base = `http://127.0.0.1:${appPort}`;
  rpcUrl = `http://127.0.0.1:${chainPort}`;
  await startChain();
  api = spawnNode(['server/index.mjs'], { APP_PORT: String(appPort), CHAIN_PORT: String(chainPort) });
  await waitFor(async () => (await request('/api/state')).body.connected, api);
  const connection = new FetchRequest(rpcUrl);
  connection.timeout = 2000;
  provider = new JsonRpcProvider(connection, { chainId: 31337, name: 'test' }, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
}, { timeout: 30000 });
after(async () => {
  provider?.destroy();
  await Promise.all([...children].map(stop));
});

test('initial state connects to a genuine local EVM and rejects records before deployment', async () => {
  const { status, body } = await request('/api/state');
  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.chainId, 31337);
  assert.equal(body.contractAddress, null);
  assert.equal(body.deployment, null);
  assert.deepEqual(body.records, []);
  assert.equal(body.balanceEth, '10000.0');
  assert.match(body.account, /^0x[0-9a-fA-F]{40}$/);
  assert.equal((await request('/api/records', { text: 'hello', idempotencyKey: 'before-deploy' })).status, 409);
});

test('concurrent deployment is single-flight and produces real runtime bytecode and mined receipt', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => request('/api/deploy', {})));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.contractAddress)).size, 1);
  const result = results[0].body;
  contractAddress = result.contractAddress;
  assert.equal(result.deployment.status, 'confirmed');
  assert.equal(result.deployment.contractAddress, contractAddress);
  assert.ok(BigInt(result.deployment.gasUsed) > 0n);
  const artifact = await compileContract();
  assert.equal(await rpc('eth_getCode', [contractAddress, 'latest']), artifact.deployedBytecode);
  const receipt = await rpc('eth_getTransactionReceipt', [result.deployment.transactionHash]);
  assert.equal(Number(receipt.status), 1);
  assert.equal(receipt.blockHash, result.deployment.blockHash);
  assert.equal(Number(await rpc('eth_blockNumber')), 1);
});

test('store / chain readback / transaction receipt use exact UTF-8 SHA-256 with no source text retained', async () => {
  const text = '  我在武汉写下第一条链上记录 👩🏽‍💻\n';
  const result = await request('/api/records', { text, idempotencyKey: 'first-record-001' });
  assert.equal(result.status, 200);
  firstRecord = result.body.record;
  assert.equal(firstRecord.id, 1);
  assert.equal(firstRecord.digest, `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`);
  assert.equal(firstRecord.status, 'confirmed');
  assert.equal(typeof firstRecord.timestamp, 'number');
  assert.equal((await request(`/api/records/${firstRecord.id}`)).body.record.digest, firstRecord.digest);
  const receipt = await request(`/api/transaction/${firstRecord.transactionHash}`);
  assert.equal(receipt.body.receipt.blockHash, firstRecord.blockHash);
  assert.equal(receipt.body.receipt.status, 'confirmed');
  const artifact = await compileContract();
  const stored = await new Contract(contractAddress, artifact.abi, provider).getRecord(1);
  assert.equal(stored.digest, firstRecord.digest);
  assert.equal(stored.author, firstRecord.author);
  assert.equal(Number(stored.timestamp), firstRecord.timestamp);
  const state = await request('/api/state');
  assert.equal(state.body.recordCount, 1);
  assert.equal(JSON.stringify(state.body).includes('我在武汉'), false);
  assert.equal('text' in state.body.records[0], false);
});

test('verification detects tampering, trailing spaces, and Unicode normalization differences', async () => {
  const original = '  我在武汉写下第一条链上记录 👩🏽‍💻\n';
  assert.equal((await request('/api/verify', { id: 1, text: original })).body.match, true);
  for (const text of [original.trim(), `${original} `, original.replace('武汉', '上海')]) {
    const result = await request('/api/verify', { id: 1, text });
    assert.equal(result.status, 200);
    assert.equal(result.body.match, false);
    assert.equal(result.body.storedDigest, firstRecord.digest);
  }
  const accented = await request('/api/records', { text: '\u00e9', idempotencyKey: 'unicode-normalization' });
  assert.equal((await request('/api/verify', { id: accented.body.record.id, text: 'e\u0301' })).body.match, false);
});

test('input limits count Unicode code points; malformed / empty / oversized inputs fail cleanly', async () => {
  for (const text of ['', ' \n\t ', 123, {}, null, '\ud800', '🧱'.repeat(1001)]) {
    const result = await request('/api/records', { text, idempotencyKey: 'invalid-input-key' });
    assert.equal(result.status, 400, JSON.stringify(text).slice(0, 40));
    assert.equal(typeof result.body.message, 'string');
    assert.equal('stack' in result.body, false);
  }
  assert.equal((await request('/api/records', { text: '🧱'.repeat(1000), idempotencyKey: 'unicode-1000-key' })).status, 200);
  assert.equal((await request('/api/records', { text: '好'.repeat(20000), idempotencyKey: 'too-large-body' })).status, 413);
  assert.equal((await request('/api/records', { text: 'hello', idempotencyKey: 'short' })).status, 400);
  assert.equal((await request('/api/records/0')).status, 400);
  assert.equal((await request('/api/records/9999')).status, 404);
  assert.equal((await request('/api/verify', { id: 'not-a-number', text: 'hello' })).status, 400);
  const malformed = await fetch(`${base}/api/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
});

test('concurrent repeated clicks coalesce, retry returns identical receipt, conflicting text is rejected', async () => {
  const before = (await request('/api/state')).body.recordCount;
  const payload = { text: '重复点击只写入一次', idempotencyKey: 'repeated-click-key' };
  const results = await Promise.all(Array.from({ length: 12 }, () => request('/api/records', payload)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.record.transactionHash)).size, 1);
  const retry = await request('/api/records', payload);
  assert.deepEqual(retry.body, results[0].body);
  assert.equal((await request('/api/state')).body.recordCount, before + 1);
  const conflict = await request('/api/records', { ...payload, text: 'different' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'IDEMPOTENCY_CONFLICT');
});

test('contract is append-only: different sender can append but cannot overwrite an existing id', async () => {
  const { abi } = await compileContract();
  const contract = new Contract(contractAddress, abi, await provider.getSigner(1));
  const original = await contract.getRecord(1);
  const count = await contract.recordCount();
  const transaction = await contract.append(`0x${'12'.repeat(32)}`);
  assert.equal((await transaction.wait()).status, 1);
  assert.equal(await contract.recordCount(), count + 1n);
  assert.equal((await contract.getRecord(1)).digest, original.digest);
  assert.equal((await contract.getRecord(count + 1n)).author, await (await provider.getSigner(1)).getAddress());
  assert.equal(abi.some((entry) => /update|delete|overwrite|setRecord/i.test(entry.name || '')), false);
  await assert.rejects(provider.call({ to: contractAddress, data: '0xffffffff' }));
  await assert.rejects(contract.append(`0x${'00'.repeat(32)}`));
  assert.equal((await request('/api/state')).body.recordCount, Number(count + 1n));
});

test('same-origin and local-host security boundaries reject cross-site writes and DNS rebinding', async () => {
  const crossOrigin = await request('/api/deploy', {}, { Origin: 'https://malicious.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error, 'ORIGIN_NOT_ALLOWED');
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/state`, { headers: { Host: `malicious.example:${appPort}` } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await request('/api/deploy', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/state', undefined, { Origin: base })).status, 200);
  const state = await request('/api/state');
  assert.match(state.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(state.headers.get('access-control-allow-origin'), null);
  assert.equal((await request('/api/unknown')).status, 404);
});

test('chain disconnection reports a recoverable error; fresh chain invalidates stale contract and old request keys', { timeout: 20000 }, async () => {
  const previous = (await request('/api/state')).body;
  assert.ok(previous.contractAddress);
  await stop(chain);
  const disconnected = await request('/api/state');
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.connected, false);
  assert.equal(disconnected.body.contractAddress, null);
  assert.equal(disconnected.body.error, 'CHAIN_UNAVAILABLE');
  assert.equal((await request('/api/deploy', {})).status, 503);
  assert.equal((await request('/api/records/1')).status, 503);
  await startChain();
  const fresh = await request('/api/state');
  assert.equal(fresh.body.connected, true);
  assert.equal(fresh.body.contractAddress, null);
  assert.deepEqual(fresh.body.records, []);
  assert.equal((await request('/api/records', { text: '重复点击只写入一次', idempotencyKey: 'repeated-click-key' })).status, 409);
  assert.equal((await request('/api/deploy', {})).status, 200);
  const next = await request('/api/records', { text: '重复点击只写入一次', idempotencyKey: 'repeated-click-key' });
  assert.equal(next.status, 200);
  assert.equal(next.body.record.id, 1);
});

test('npm-start launcher serves static UI and shuts down both local servers together', { timeout: 20000 }, async () => {
  const otherApp = await unusedPort();
  let otherChain;
  do { otherChain = await unusedPort(); } while (otherChain === otherApp);
  const launcher = spawnNode(['scripts/start.mjs'], { APP_PORT: String(otherApp), CHAIN_PORT: String(otherChain) });
  const url = `http://127.0.0.1:${otherApp}`;
  try {
    await waitFor(async () => (await (await fetch(`${url}/api/state`)).json()).connected, launcher);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html>/i);
    for (const file of ['/app.js', '/styles.css']) assert.equal((await fetch(`${url}${file}`)).status, 200);
    assert.equal((await fetch(`${url}/..%2fpackage.json`)).status, 404);
    await stop(launcher);
    assert.equal(launcher.exitCode, 0);
    await assert.rejects(fetch(`${url}/api/state`));
    await assert.rejects(fetch(`http://127.0.0.1:${otherChain}`));
  } finally { await stop(launcher); }
});

test('API refuses a local RPC that reports a non-teaching chain id', { timeout: 15000 }, async () => {
  const wrongRpc = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks));
    const result = call.method === 'eth_chainId' ? '0x1' : { clientVersion: 'edr/local', instanceId: 'different' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  wrongRpc.listen(0, '127.0.0.1');
  await once(wrongRpc, 'listening');
  const wrongPort = wrongRpc.address().port;
  const otherApp = await unusedPort();
  const unsafeApi = spawnNode(['server/index.mjs'], { APP_PORT: String(otherApp), CHAIN_PORT: String(wrongPort) });
  const url = `http://127.0.0.1:${otherApp}`;
  try {
    await waitFor(async () => (await fetch(`${url}/api/state`)).ok, unsafeApi);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.connected, false);
    assert.equal(state.error, 'UNSAFE_CHAIN');
    const deploy = await fetch(`${url}/api/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(deploy.status, 503);
    assert.equal((await deploy.json()).error, 'UNSAFE_CHAIN');
  } finally {
    await stop(unsafeApi);
    wrongRpc.closeAllConnections();
    await new Promise((resolve) => wrongRpc.close(resolve));
  }
});
