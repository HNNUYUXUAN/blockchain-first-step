import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger, ApiError, normalizeError } from './ledger.mjs';
import { APP_HOST, APP_PORT } from './config.mjs';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const ledger = await createLedger();
const MAX_BODY = 12 * 1024;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
function guardRequest(request) {
  // Reject DNS rebinding and cross-origin websites controlling the unlocked teaching account.
  const allowedHosts = new Set([`127.0.0.1:${APP_PORT}`, `localhost:${APP_PORT}`]);
  if (!allowedHosts.has(request.headers.host)) throw new ApiError(403, 'HOST_NOT_ALLOWED', '实验只接受本机访问');
  if (request.headers.origin && !new Set([`http://127.0.0.1:${APP_PORT}`, `http://localhost:${APP_PORT}`]).has(request.headers.origin)) {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '实验只接受同源页面请求');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '实验只接受同源页面请求');
}
async function body(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式');
  }
  if (Number(request.headers['content-length']) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}'); }
  catch { throw new ApiError(400, 'INVALID_JSON', '请求不是有效的 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'INVALID_JSON', '请求必须是 JSON 对象');
  return parsed;
}
async function staticFile(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方法');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'INVALID_PATH', '路径格式不正确'); }
  const candidate = path.resolve(PUBLIC, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!candidate.startsWith(`${PUBLIC}${path.sep}`)) throw new ApiError(404, 'NOT_FOUND', '未找到页面');
  try {
    const actual = await realpath(candidate);
    if (!actual.startsWith(`${PUBLIC}${path.sep}`) || !(await stat(actual)).isFile()) throw new Error('not file');
    const data = await readFile(actual);
    response.writeHead(200, { 'Content-Type': MIME[path.extname(actual)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { throw new ApiError(404, 'NOT_FOUND', '未找到页面'); }
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try {
    guardRequest(request);
    const url = new URL(request.url, `http://127.0.0.1:${APP_PORT}`);
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/state') return json(response, 200, await ledger.state());
    if (route === 'POST /api/deploy') {
      await body(request);
      return json(response, 200, await ledger.deploy());
    }
    if (route === 'POST /api/records') return json(response, 200, await ledger.append(await body(request)));
    if (route === 'POST /api/verify') return json(response, 200, await ledger.verify(await body(request)));
    const record = /^\/api\/records\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && record) return json(response, 200, await ledger.read(record[1]));
    const transaction = /^\/api\/transaction\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && transaction) return json(response, 200, await ledger.transaction(transaction[1]));
    if (url.pathname.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', '未找到 API');
    await staticFile(request, response, url.pathname);
  } catch (error) {
    const safe = normalizeError(error);
    if (!response.headersSent) json(response, safe.status, { error: safe.code, message: safe.message });
    else response.end();
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${APP_PORT} 已占用，请修改 APP_PORT` : '无法启动本地实验服务');
  ledger.close();
  process.exitCode = 1;
});
server.listen(APP_PORT, APP_HOST, () => console.log(`学习实验已就绪：http://${APP_HOST}:${APP_PORT}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  ledger.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
