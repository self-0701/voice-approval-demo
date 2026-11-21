const LOCAL_KEY = 'voice-rights-registry-v2';
const CHAIN_ID = 10143;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ABI = [
  'function administrator() view returns (address)',
  'function authorizations(bytes32) view returns (address voiceActor, address producer, bytes32 scopeHash, uint64 validUntil, bool revoked)',
  'function submissions(bytes32) view returns (bytes32 authorizationId, bytes32 fileHash, address producer)',
  'function reviews(bytes32) view returns (address reviewer, uint8 decision, uint64 decidedAt)',
  'function registerAuthorization(bytes32 id, address producer, bytes32 scopeHash, uint64 validUntil)',
  'function revokeAuthorization(bytes32 id)',
  'function registerSubmission(bytes32 id, bytes32 authorizationId, bytes32 scopeHash, bytes32 fileHash)',
  'function recordReview(bytes32 submissionId, uint8 decision)',
];

export const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
export const DEFAULT_CONTRACT = '0x85eB82304D36dC2bA1A256359107E5d8D104B085';
export const DEMO_ACTOR = '林岚（演示配音员）';
export const DEMO_PRODUCER = '南岸制作工作室';
const DEMO_REVIEWER = '周岑（演示审核员）';
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function isAddress(value) {
  return /^0x[0-9a-f]{40}$/i.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `0x${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function scopeHash(scope) {
  const fields = [scope.project, scope.version, scope.script, scope.usage];
  return sha256(new TextEncoder().encode(JSON.stringify(fields)));
}

export function authorizationStatus(record) {
  if (!record) return '缺失';
  if (record.revoked) return '已撤销';
  return record.validUntil < nowSeconds() ? '已过期' : '有效';
}

export function requireActiveAuthorization(record) {
  const status = authorizationStatus(record);
  if (status !== '有效') throw new Error(`授权${status}`);
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function localRegistry() {
  const read = () => JSON.parse(localStorage.getItem(LOCAL_KEY) || '{"authorizations":{},"submissions":{},"reviews":{}}');
  const save = records => localStorage.setItem(LOCAL_KEY, JSON.stringify(records));

  return {
    key: 'local',
    async getAuthorization(id) { return read().authorizations[id] ?? null; },
    async getSubmission(id) { return read().submissions[id] ?? null; },
    async getReview(id) { return read().reviews[id] ?? null; },
    async authorize(id, producer, hash, validUntil) {
      if (validUntil <= nowSeconds()) throw new Error('请填写未来的授权有效期');
      const records = read();
      records.authorizations[id] = { voiceActor: DEMO_ACTOR, producer, scopeHash: hash, validUntil, revoked: false };
      save(records);
    },
    async revoke(id) {
      const records = read();
      const authorization = records.authorizations[id];
      if (!authorization || authorization.revoked) throw new Error('授权已撤销或不存在');
      authorization.revoked = true;
      save(records);
    },
    async submit(id, authorizationId, hash, fileHash, producer) {
      const records = read();
      const authorization = records.authorizations[authorizationId];
      requireActiveAuthorization(authorization);
      if (authorization.producer !== producer) throw new Error('提交方与授权单不一致');
      if (authorization.scopeHash !== hash) throw new Error('项目、台词或用途与授权单不一致');
      records.submissions[id] = { authorizationId, fileHash, producer };
      save(records);
    },
    async decide(id, decision) {
      const records = read();
      const submission = records.submissions[id];
      if (!submission) throw new Error('送审记录不存在');
      if (records.reviews[id]) throw new Error('该成品已有审核决定');
      if (decision === 'approved') requireActiveAuthorization(records.authorizations[submission.authorizationId]);
      records.reviews[id] = { reviewer: DEMO_REVIEWER, decision, decidedAt: nowSeconds() };
      save(records);
    },
  };
}

async function monadRegistry(config) {
  if (!isAddress(config.address)) throw new Error('请填写有效的 Monad 测试网合约地址');
  const ethers = await import('./node_modules/ethers/dist/ethers.min.js').catch(() => {
    throw new Error('缺少链上依赖，请在项目目录运行 npm ci 后刷新页面');
  });
  const { BrowserProvider, Contract, FetchRequest, JsonRpcProvider } = ethers;
  const address = config.address.toLowerCase();
  const request = new FetchRequest(config.rpc);
  request.timeout = 12000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  const contract = new Contract(address, ABI, provider);
  try {
    if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('RPC 须连接 Monad 测试网（10143）');
    if (await provider.getCode(address) === '0x') throw new Error('该地址没有已部署的合约');
    await contract.administrator();
  } catch (error) {
    provider.destroy();
    throw error;
  }

  async function write(method, ...args) {
    if (!window.ethereum) throw new Error('请在装有浏览器钱包的浏览器中打开此页面');
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (BigInt(chainId) !== BigInt(CHAIN_ID)) {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
      });
    }
    const wallet = new BrowserProvider(window.ethereum);
    const tx = await contract.connect(await wallet.getSigner())[method](...args);
    await tx.wait();
  }

  return {
    key: `monad:${address}`,
    close: () => provider.destroy(),
    async getAuthorization(id) {
      const result = await contract.authorizations(id);
      if (result.voiceActor === ZERO_ADDRESS) return null;
      const { voiceActor, producer, scopeHash: hash, validUntil, revoked } = result;
      return { voiceActor, producer, scopeHash: hash, validUntil: Number(validUntil), revoked };
    },
    async getSubmission(id) {
      const { authorizationId, fileHash, producer } = await contract.submissions(id);
      return producer === ZERO_ADDRESS ? null : { authorizationId, fileHash, producer };
    },
    async getReview(id) {
      const { reviewer, decision, decidedAt } = await contract.reviews(id);
      if (!decision) return null;
      return { reviewer, decision: decision === 1n ? 'approved' : 'rejected', decidedAt: Number(decidedAt) };
    },
    authorize: (id, producer, hash, validUntil) => write('registerAuthorization', id, producer.toLowerCase(), hash, validUntil),
    revoke: id => write('revokeAuthorization', id),
    submit: (id, authorizationId, hash, fileHash) => write('registerSubmission', id, authorizationId, hash, fileHash),
    decide: (id, decision) => write('recordReview', id, decision === 'approved' ? 1 : 2),
  };
}

export function openRegistry(config) {
  return config.address ? monadRegistry(config) : localRegistry();
}
