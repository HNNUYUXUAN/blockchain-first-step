# 第三方来源与许可

本项目复用成熟的 EVM 开发工具，没有从零实现底层链，也未复制完整教学平台。以下版本以 package-lock.json 为可复现依据。首次选型已查阅官方文档与仓库。

## 实际安装的直接依赖

| 工具 | 固定版本 | 用途 | 上游 / 许可证 |
|---|---|---|---|
| Hardhat | 3.18.1 | 本地 EVM 节点 | https://github.com/NomicFoundation/hardhat · 主包 MIT |
| ethers | 6.17.0 | 账户/合约调用/回执 | https://github.com/ethers-io/ethers.js · MIT |
| solc (solc-js) | 0.8.37 | 本地 Solidity 编译 | https://github.com/ethereum/solc-js · 本包 MIT；内含 Solidity 编译器另适用其分发许可 |
| jsdom | 30.1.1 | 非渲染 DOM 逻辑测试 | https://github.com/jsdom/jsdom · MIT |
| Playwright | 1.61.1 | 浏览器自动测试 | https://github.com/microsoft/playwright · Apache-2.0 |

实际依赖包的许可原文位于安装后 node_modules 各包的 LICENSE / COPYING 文件。`third-party-licenses/` 保留直接依赖随包提供的许可证副本；传递依赖受各自许可证约束。Chromium 是测试时调用的浏览器，本源码 ZIP 不分发其二进制。

## 选型参考，未复制其实现或正文

- [Scaffold-ETH 2](https://github.com/scaffold-eth/scaffold-eth-2)：MIT；参考本地链、账户与合约读写的教学组织方式。完整框架对本实验偏重，未引入其前端栈
- [SpeedRunEthereum challenges](https://github.com/scaffold-eth/se-2-challenges)：MIT；参考短任务与自测反馈的教学节奏，未复制挑战代码或平台
- [Foundry](https://github.com/foundry-rs/foundry)：MIT / Apache-2.0 双许可；Anvil 是可选替代节点，本项目为了只保留 Node 工具链未使用
- [WTF Solidity](https://github.com/AmazingAng/WTF-Solidity)：教程正文 CC BY-NC-SA 4.0、代码示例 MIT。本项目中文解释独立编写，仅链接延伸阅读，不把非商用正文混入 MIT 文档

## 官方延伸阅读

- [Hardhat 3 入门](https://hardhat.org/docs/getting-started)
- [Hardhat 本地节点](https://hardhat.org/docs/guides/local-development-node)
- [ethers 文档](https://docs.ethers.org/v6/)
- [Solidity 文档](https://docs.soliditylang.org/)
- [Ethereum 账户介绍](https://ethereum.org/en/developers/docs/accounts/)
- [Ethereum 交易介绍](https://ethereum.org/en/developers/docs/transactions/)

这些链接和上游版本会随时间变化。本项目锁定版本，不应不加测试地让 AI 混用 Hardhat 2 和 3 的 API。
