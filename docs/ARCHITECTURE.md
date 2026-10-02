# 数据流与边界

## 一句话架构

浏览器（原生 HTML/CSS/JS） → 本地 Node HTTP 服务（ethers + solc） → Hardhat 的本地 EVM（Chain ID 31337）。

本地开发链不是伪造模拟日志：真正执行编译后的 EVM 字节码，维护账户、合约存储、交易与区块。它仍然是可控制、可重置的单节点开发环境，不具备公网去中心化共识保证。

## 数据在哪里

- 浏览器内存：输入原文、本次请求标识、刚计算的 SHA-256 摘要、显示状态
- 服务请求内存：原文用于计算 SHA-256，随后仅缓存摘要、请求 promise 和回执；不把原文写入日志/磁盘
- 合约存储：32 字节摘要、`msg.sender` 地址、`block.timestamp`；按递增 ID 追加
- 本地节点内存：交易、区块和执行状态；停止节点后丢失
- 磁盘：源码、依赖；自动测试另外写出无敏感示例的证据文件

原文从浏览器发送给同机 HTTP 服务，**不是始终只在浏览器**。摘要同样可能泄露可猜测内容，因此不应输入秘密。

## 为什么有两个摘要计算

浏览器用 Web Crypto `SHA-256`，服务用 Node `createHash('sha256')`，两者都按输入原样 UTF-8 编码。浏览器会核对返回摘要与本地结果。合约存 32 字节值，不自行读取文字或判断内容真假。

注意：Solidity/Ethereum 常见的 Keccak-256 与这里的 SHA-256 不是同一个算法。这个实验选择 SHA-256 做内容指纹；交易哈希和区块哈希由底层链按自身协议产生，不应混为一谈。

## 接口

所有写操作只接受同源 JSON。`GET /api/state` 从节点读取状态，包括当前区块、余额、合约和最近 100 条记录；更旧的记录仍可按 ID 读取。

| 方法 / 路径 | 输入 | 返回 |
|---|---|---|
| GET /api/state | 无 | connected、chainId、blockNumber、account、balanceEth、contractAddress、records、deployment |
| POST /api/deploy | `{}` | contractAddress、真实部署回执 deployment |
| POST /api/records | text、idempotencyKey | record、receipt |
| GET /api/records/:id | 正整数 ID | record |
| POST /api/verify | id、text | match、digest、storedDigest、record |
| GET /api/transaction/:hash | 交易哈希 | receipt |

回执包含 transactionHash、blockNumber、blockHash、gasUsed、status、from、to 等真实链字段。成功必须等回执 `status === 1`，并非仅收到交易哈希。

## 幂等与失败

前端在操作中禁用按钮，服务串行处理写交易。同一个 idempotencyKey 只能绑定同一个摘要，并复用请求结果；不同内容复用同一个 key 会得到 409。缓存仅覆盖当前 API 进程生命周期。

若交易结果不确定，服务保留该请求的结果 promise，不会盲目重复发送。某些底层 RPC 故障会要求用户重启本地实验；这是有意偏向避免重复写入的教学策略，不是生产级事务恢复系统。

Hardhat 实例 ID 改变、已部署字节码不一致或部署区块不一致时，API 清除旧合约索引及请求缓存，要求重新部署。

## 安全限制

- 服务和节点都硬编码绑定 `127.0.0.1`
- 固定 chainId 31337，并检查 Hardhat 元数据；拒绝任意公网 RPC 配置
- HTTP 校验 Host、Origin、Sec-Fetch-Site，缓解恶意网页跨站操作与 DNS rebinding
- 静态目录 realpath 检查，禁止读取目录外文件
- CSP 限制脚本为同源资源；页面将输入作为文本，避免 HTML 注入
- 单请求最大 12 KiB，文字最大 1,000 个 Unicode 码点；拒绝不完整 surrogate 字符
- 不保存真实密钥；使用 Hardhat 已解锁公开测试账户。启动脚本不打印节点默认公开私钥

以上是教学原型的基础防护，不是安全审计结论。不可公网暴露。
