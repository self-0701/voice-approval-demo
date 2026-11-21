import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import solc from 'solc';
import { ethers } from 'ethers';

const root = process.cwd();
const configPath = path.join(root, 'monad-config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const privateKey = process.env.MONAD_PRIVATE_KEY;
if (!privateKey) throw new Error('MONAD_PRIVATE_KEY is required in a local .env file.');

const source = await fs.readFile(path.join(root, 'contracts', 'VoiceRightsRegistry.sol'), 'utf8');
const input = { language: 'Solidity', sources: { 'VoiceRightsRegistry.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((item) => item.severity === 'error');
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
const artifact = output.contracts['VoiceRightsRegistry.sol'].VoiceRightsRegistry;
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
await fs.writeFile(path.join(root, 'artifacts', 'VoiceRightsRegistry.json'), `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`);

const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL || config.rpcUrl, 10143, { staticNetwork: true });
const wallet = new ethers.Wallet(privateKey, provider);
const reviewer = process.env.REVIEWER_ADDRESS || wallet.address;
const balance = await provider.getBalance(wallet.address);
if (balance === 0n) throw new Error('Deployer wallet has no MON testnet balance.');
const factory = new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, wallet);
const contract = await factory.deploy(reviewer);
const tx = contract.deploymentTransaction();
await contract.waitForDeployment();
const address = await contract.getAddress();
const next = { ...config, contractAddress: address, deploymentTx: tx.hash, deployer: wallet.address, reviewer, deployedAt: new Date().toISOString() };
await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(JSON.stringify({ address, deploymentTx: tx.hash, reviewer, deployer: wallet.address }, null, 2));
