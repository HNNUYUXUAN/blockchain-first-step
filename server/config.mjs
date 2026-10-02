export function port(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return Number(value);
}

export const APP_HOST = '127.0.0.1';
export const CHAIN_HOST = '127.0.0.1';
export const CHAIN_ID = 31337;
export const APP_PORT = port(process.env.APP_PORT, 4173, 'APP_PORT');
export const CHAIN_PORT = port(process.env.CHAIN_PORT, 8545, 'CHAIN_PORT');
export const RPC_URL = `http://${CHAIN_HOST}:${CHAIN_PORT}`;
if (APP_PORT === CHAIN_PORT) throw new Error('APP_PORT and CHAIN_PORT must differ');
