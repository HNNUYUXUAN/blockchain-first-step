import { readFile } from 'node:fs/promises';
import solc from 'solc';

let artifact;
export async function compileContract() {
  if (artifact) return artifact;
  const source = await readFile(new URL('../contracts/FirstProof.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'FirstProof.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(`Local Solidity compilation failed: ${errors.map((e) => e.message).join('; ')}`);
  const compiled = output.contracts['FirstProof.sol'].FirstProof;
  artifact = {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    compilerVersion: solc.version(),
  };
  return artifact;
}
