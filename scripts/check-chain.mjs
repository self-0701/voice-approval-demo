import 'dotenv/config';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../monad-config.json', import.meta.url), 'utf8'));
const rpcUrl = process.env.MONAD_RPC_URL || config.rpcUrl;
const response = await fetch(rpcUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
});
if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
const payload = await response.json();
if (payload.error) throw new Error(payload.error.message);
const chainId = Number.parseInt(payload.result, 16);
console.log(JSON.stringify({ rpcUrl, chainId, expectedChainId: 10143, chainMatches: chainId === 10143, contractAddress: config.contractAddress || null }, null, 2));
if (chainId !== 10143) process.exitCode = 1;
