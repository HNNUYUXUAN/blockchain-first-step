// No public RPC, private key, mnemonic, or external chain configuration.
export default {
  networks: {
    localDemo: {
      type: 'edr-simulated',
      chainType: 'l1',
      chainId: 31337,
      loggingEnabled: false,
      mining: { auto: true },
    },
  },
};
