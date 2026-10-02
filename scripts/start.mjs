import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { APP_HOST, APP_PORT, CHAIN_HOST, CHAIN_PORT, RPC_URL, CHAIN_ID } from '../server/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hardhat = fileURLToPath(new URL('../node_modules/hardhat/dist/src/cli.js', import.meta.url));
const apiFile = fileURLToPath(new URL('../server/index.mjs', import.meta.url));
const children = [];
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(code);
  }, 2500);
  Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))))
    .then(() => { clearTimeout(timer); process.exit(code); });
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
async function assertFree(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${port} 已占用，请关闭旧实验，或设置不同的 APP_PORT / CHAIN_PORT`)));
    server.listen(port, host, () => server.close(resolve));
  });
}
function child(file, args, name, showOutput = false) {
  const processChild = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(processChild);
  // Hardhat prints publicly-known development keys; do not display or persist that output.
  processChild.stdout.on('data', (data) => { if (showOutput) process.stdout.write(data); });
  processChild.stderr.on('data', (data) => { if (showOutput) process.stderr.write(data); });
  processChild.on('error', () => { console.error(`${name} 启动失败`); shutdown(1); });
  processChild.on('exit', (code) => {
    if (!stopping) { console.error(`${name} 已停止（${code ?? 'signal'}），实验服务将一起关闭`); shutdown(code || 1); }
  });
  return processChild;
}
try {
  await assertFree(APP_HOST, APP_PORT);
  await assertFree(CHAIN_HOST, CHAIN_PORT);
  console.log('正在启动本机教学链（无真实资产，不连接公网链）…');
  child(hardhat, ['node', '--hostname', CHAIN_HOST, '--port', String(CHAIN_PORT), '--network', 'localDemo'], '教学链');
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      const response = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(500) });
      if (Number((await response.json()).result) === CHAIN_ID) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error('教学链未能及时启动，请确认 Node.js 24+ 和依赖已安装');
  console.log(`本机 EVM 已连接：127.0.0.1:${CHAIN_PORT} · Chain ID ${CHAIN_ID}`);
  console.log('关闭终端或按 Ctrl+C 将清空教学链。不要向教学账户发送任何真实资产。');
  child(apiFile, [], '实验页面', true);
} catch (error) {
  console.error(error.message);
  shutdown(1);
}
