import { createHash } from 'node:crypto';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, formatEther } from 'ethers';
import { compileContract } from './compile.mjs';
import { CHAIN_ID, RPC_URL } from './config.mjs';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function digestText(text) {
  if (typeof text !== 'string') throw new ApiError(400, 'INVALID_TEXT', '请输入文字，不能使用数字或其他类型');
  if (!text.isWellFormed()) throw new ApiError(400, 'INVALID_TEXT', '文字包含无效的 Unicode 字符');
  if (!text.trim()) throw new ApiError(400, 'EMPTY_TEXT', '请先写下一句话，不能只输入空白');
  if (Array.from(text).length > 1000) throw new ApiError(400, 'TEXT_TOO_LONG', '最多支持 1000 个 Unicode 字符');
  // Whitespace, case and Unicode normalization are intentionally preserved.
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
export function parseId(input) {
  if (!/^\d+$/.test(String(input)) || !Number.isSafeInteger(Number(input)) || Number(input) < 1) {
    throw new ApiError(400, 'INVALID_ID', '记录编号必须是正整数');
  }
  return Number(input);
}
function receiptView(receipt) {
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? 'confirmed' : 'failed',
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
  };
}

export async function createLedger() {
  const artifact = await compileContract();
  const connection = new FetchRequest(RPC_URL);
  connection.timeout = 2000;
  // RPC is constructed from a validated local port; arbitrary endpoint env vars are not accepted.
  const provider = new JsonRpcProvider(connection, { name: 'local-learning', chainId: CHAIN_ID }, {
    staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1,
  });
  provider.pollingInterval = 100;
  provider.on('error', () => {});
  let address = null;
  let deployment = null;
  let instanceId = null;
  let account = null;
  let queue = Promise.resolve();
  const keys = new Map();
  const receipts = new Map();

  function reset() {
    address = null;
    deployment = null;
    receipts.clear();
    keys.clear();
  }
  function serialize(fn) {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  }
  async function checkChain() {
    try {
      const [chainIdHex, metadata] = await Promise.all([
        provider.send('eth_chainId', []), provider.send('hardhat_metadata', []),
      ]);
      if (Number(chainIdHex) !== CHAIN_ID || !metadata.clientVersion?.startsWith('edr/')) {
        throw new ApiError(503, 'UNSAFE_CHAIN', '此实验只允许连接本机 Hardhat 教学链（31337）');
      }
      if (instanceId !== null && metadata.instanceId !== instanceId) reset();
      instanceId = metadata.instanceId;
      if (address) {
        const [code, block] = await Promise.all([
          provider.getCode(address), provider.getBlock(deployment.blockNumber),
        ]);
        if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase() || block?.hash !== deployment.blockHash) reset();
      }
      const accounts = await provider.send('eth_accounts', []);
      if (!accounts.length) throw new ApiError(503, 'NO_LOCAL_ACCOUNT', '教学账户暂不可用，请重启实验');
      account = accounts[0];
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', '本地教学链暂未连接，请确认实验仍在运行后重试');
    }
  }
  function requireDeployment() {
    if (!address) throw new ApiError(409, 'CONTRACT_NOT_DEPLOYED', '请先部署合约；重启教学链后需要重新部署');
    return new Contract(address, artifact.abi, provider);
  }
  async function getRecord(id) {
    const contract = requireDeployment();
    const count = Number(await contract.recordCount());
    if (id > count) throw new ApiError(404, 'RECORD_NOT_FOUND', '教学链上没有这条记录');
    const record = await contract.getRecord(id);
    let receipt = receipts.get(id);
    if (!receipt) {
      const events = await contract.queryFilter(contract.filters.RecordAdded(id), deployment.blockNumber, 'latest');
      if (!events.length) throw new ApiError(503, 'RECEIPT_UNAVAILABLE', '记录存在，但交易回执暂不可用，请重试');
      receipt = await provider.getTransactionReceipt(events[0].transactionHash);
      if (!receipt || receipt.status !== 1) throw new ApiError(503, 'RECEIPT_UNAVAILABLE', '交易尚未确认，请稍后重试');
      receipts.set(id, receipt);
    }
    return {
      id, digest: record.digest, author: record.author, timestamp: Number(record.timestamp),
      transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(), status: receipt.status === 1 ? 'confirmed' : 'failed',
    };
  }
  async function state() {
    try {
      await checkChain();
      const [blockNumberHex, balance] = await Promise.all([
        provider.send('eth_blockNumber', []), provider.getBalance(account),
      ]);
      let records = [];
      let recordCount = 0;
      if (address) {
        recordCount = Number(await requireDeployment().recordCount());
        // Latest 100 records keep refresh work bounded. Every older record remains readable by id.
        for (let id = Math.max(1, recordCount - 99); id <= recordCount; id++) records.push(await getRecord(id));
      }
      return {
        connected: true, chainId: CHAIN_ID, blockNumber: Number(blockNumberHex), account,
        balanceEth: formatEther(balance), contractAddress: address, records, recordCount, deployment,
      };
    } catch (error) {
      const safe = normalizeError(error);
      return {
        connected: false, chainId: CHAIN_ID, blockNumber: null, account: null, balanceEth: null,
        contractAddress: null, records: [], recordCount: 0, deployment: null,
        error: safe.code, message: safe.message,
      };
    }
  }
  async function deploy() {
    return serialize(async () => {
      await checkChain();
      if (address) return { contractAddress: address, deployment };
      const signer = await provider.getSigner(account);
      const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
      const receipt = await contract.deploymentTransaction().wait(1, 15000);
      if (!receipt || receipt.status !== 1) throw new ApiError(503, 'DEPLOY_FAILED', '合约部署未确认，请检查教学链后重试');
      const nextAddress = await contract.getAddress();
      const code = await provider.getCode(nextAddress);
      if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw new ApiError(503, 'DEPLOY_FAILED', '合约代码校验失败');
      address = nextAddress;
      deployment = receiptView(receipt);
      return { contractAddress: address, deployment };
    });
  }
  async function append({ text, idempotencyKey } = {}) {
    const digest = digestText(text);
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '请求标识无效，请刷新页面后重试');
    }
    // Check chain generation before returning a cached response from an earlier chain instance.
    await checkChain();
    requireDeployment();
    const previous = keys.get(idempotencyKey);
    if (previous) {
      if (previous.digest !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同文字，请发起新操作');
      return previous.promise;
    }
    const promise = serialize(async () => {
      await checkChain();
      requireDeployment();
      const contract = new Contract(address, artifact.abi, await provider.getSigner(account));
      const transaction = await contract.append(digest);
      const receipt = await transaction.wait(1, 15000);
      if (!receipt || receipt.status !== 1) throw new ApiError(503, 'TRANSACTION_UNCONFIRMED', '交易尚未确认，请保留页面并重试同一请求');
      const event = receipt.logs.map((log) => {
        try { return contract.interface.parseLog(log); } catch { return null; }
      }).find((entry) => entry?.name === 'RecordAdded');
      if (!event) throw new ApiError(503, 'RECEIPT_UNAVAILABLE', '未找到记录事件，请保留页面并重试同一请求');
      const id = Number(event.args.id);
      receipts.set(id, receipt);
      return { record: await getRecord(id), receipt: receiptView(receipt) };
    });
    // Keep completed and uncertain requests for this API session; never blindly resend an uncertain write.
    keys.set(idempotencyKey, { digest, promise });
    return promise;
  }
  async function read(id) {
    await checkChain();
    return { record: await getRecord(parseId(id)) };
  }
  async function verify({ id, text } = {}) {
    const digest = digestText(text);
    await checkChain();
    const record = await getRecord(parseId(id));
    return { match: digest === record.digest, digest, storedDigest: record.digest, record };
  }
  async function transaction(hash) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new ApiError(400, 'INVALID_HASH', '交易哈希格式不正确');
    await checkChain();
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '未找到这笔交易的回执');
    return { receipt: receiptView(receipt) };
  }
  return { state, deploy, append, read, verify, transaction, close: () => provider.destroy() };
}

export function normalizeError(error) {
  if (error instanceof ApiError) return error;
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR'].includes(error?.code) || error?.code === 'ECONNREFUSED') {
    return new ApiError(503, 'CHAIN_UNAVAILABLE', '本地教学链暂未连接，请保留页面并稍后重试');
  }
  if (error?.code === 'CALL_EXCEPTION') return new ApiError(409, 'TRANSACTION_REJECTED', '教学链未接受这次操作，请刷新状态后重试');
  return new ApiError(500, 'INTERNAL_ERROR', '实验服务暂时出错，请稍后重试');
}
