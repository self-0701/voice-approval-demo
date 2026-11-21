import { findAudio, fingerprint, removeAudio, sampleAudio, storeAudio } from './audio.js';
import {
  authorizationStatus, DEFAULT_RPC, DEMO_ACTOR, DEMO_PRODUCER, isAddress, newId,
  openRegistry, requireActiveAuthorization, scopeHash, DEFAULT_CONTRACT,
} from './registry.js';

const STORAGE_KEY = 'voice-rights-workspace-v2';
const DEMO_SCRIPTS = { v1: '第二杯半价，今天就来坐坐。', v2: '第二杯免费，今天就来坐坐。' };
const SCOPE_FIELDS = ['project', 'version', 'script', 'usage'];
const PAGES = {
  authorize: { label: '授权确认', role: '配音员', title: '确认音色授权范围', description: '配音员确认制作方、项目、台词和用途。范围变化后，需要另行签发授权。' },
  submit: { label: '上传送审', role: '制作方', title: '提交外部制作的成品', description: '选择授权单，填写成品对应的范围。系统核对提交方和授权范围，并为这份文件计算指纹。' },
  review: { label: '机构审核', role: '审核员', title: '试听送审成品', description: '审核员对照授权和台词，试听指纹一致的音频，再决定通过或驳回。' },
  verify: { label: '独立核验', role: '接收方', title: '核验收到的音频', description: '选择交付回执并导入收到的文件，查询授权、审核决定以及文件指纹是否一致。' },
};
const app = document.querySelector('#app');

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

const prefs = readStorage(STORAGE_KEY, {});
prefs.history ??= {};
const oldAuthorization = readStorage('voice-rights-demo-v1', {}).authorization;
const defaultScope = {
  project: '咖啡店春季促销广告',
  version: 'v1',
  script: DEMO_SCRIPTS.v1,
  usage: oldAuthorization?.usage || '门店视频与短视频投放',
};
const defaultExpiry = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
let config = prefs.config ?? { address: DEFAULT_CONTRACT, rpc: DEFAULT_RPC };
let registry = await openRegistry({});
let page = Object.hasOwn(PAGES, prefs.page) ? prefs.page : 'authorize';
let authDraft;
let submitDraft;
let authorization;
let reviewCase;
let receipt;
let proof;
let pendingAudio;
let reviewAudio;
let verifyAudio;
let mediaUrl;
let notice;
let busy = false;
let configOpen = false;

const savePrefs = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
const short = value => value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, letter => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[letter]
));
const dateTime = seconds => new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
const isLocal = () => registry.key === 'local';
const networkLabel = () => isLocal() ? '本地演示' : 'Monad 测试网';

function resetWorkspace() {
  authDraft = { ...defaultScope, producer: isLocal() ? DEMO_PRODUCER : '', validUntil: defaultExpiry };
  submitDraft = { ...authDraft };
  authorization = null;
  reviewCase = null;
  receipt = null;
  proof = null;
  pendingAudio = null;
  reviewAudio = null;
  verifyAudio = null;
}

function documents(type) {
  return prefs.history[registry.key]?.[type] ?? [];
}

function remember(document) {
  const group = prefs.history[registry.key] ??= {};
  group[document.type] = [document, ...documents(document.type).filter(item => item.id !== document.id)];
  savePrefs();
}

function handoff(type, id, fields = {}) {
  return { format: 'voice-rights-v2', type, network: registry.key, id, ...fields };
}

async function importDocument(file, type) {
  if (!file || file.size > 200000) throw new Error('请选择不超过 200 KB 的 JSON 文件');
  const document = await file.text().then(JSON.parse).catch(() => null);
  if (document?.format !== 'voice-rights-v2' || document.type !== type || !/^0x[0-9a-f]{64}$/.test(document.id)) {
    throw new Error('回执或交接文件格式不正确');
  }
  if (document.network !== registry.key) throw new Error('文件来自其他账本，请先在网络配置中连接对应合约');
  if (type === 'receipt') return handoff(type, document.id);
  const scope = Object.fromEntries(SCOPE_FIELDS.map(field => [field, document.scope?.[field]]));
  if (!SCOPE_FIELDS.every(field => typeof scope[field] === 'string' && scope[field].trim() && scope[field].length <= 4000)) {
    throw new Error('交接文件缺少有效的授权范围');
  }
  return handoff(type, document.id, { scope });
}

function download(document) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `voice-rights-${document.type}-${document.id.slice(2, 14)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readScope(draft) {
  const scope = Object.fromEntries(SCOPE_FIELDS.map(field => [field, draft[field].trim()]));
  if (!SCOPE_FIELDS.every(field => scope[field])) throw new Error('请填写项目、台词版本、台词正文和用途');
  return scope;
}

async function checkScope(document, record) {
  if (!record) throw new Error('当前账本查不到该授权');
  if (await scopeHash(document.scope) !== record.scopeHash) throw new Error('交接文件的授权范围与账本不一致');
}

async function selectAuthorization(document) {
  const record = await registry.getAuthorization(document.id);
  await checkScope(document, record);
  authorization = { document, record };
  submitDraft = { ...document.scope, producer: record.producer };
  remember(document);
}

async function loadCase(id) {
  const submission = await registry.getSubmission(id);
  if (!submission) throw new Error('当前账本查不到该送审记录');
  const [grant, decision] = await Promise.all([
    registry.getAuthorization(submission.authorizationId), registry.getReview(id),
  ]);
  return { submission, grant, decision };
}

async function selectReview(document) {
  const details = await loadCase(document.id);
  await checkScope(document, details.grant);
  const savedAudio = await findAudio(document.id);
  const savedHash = savedAudio ? await fingerprint(savedAudio) : null;
  reviewAudio = savedHash === details.submission.fileHash ? savedAudio : null;
  reviewCase = { document, ...details };
  remember(document);
}

async function selectReceipt(document) {
  const details = await loadCase(document.id);
  receipt = document;
  verifyAudio = null;
  proof = { ...details, matches: null };
  remember(document);
}

function field(name, label, value, options = {}) {
  const id = `${options.prefix ?? page}-${name}`;
  const attrs = `id="${id}" name="${name}"`;
  return `<div class="field${options.full ? ' full' : ''}"><label for="${id}">${label}</label>
    ${options.area
      ? `<textarea ${attrs} maxlength="4000" required>${escapeHtml(value)}</textarea>`
      : `<input ${attrs} type="${options.type ?? 'text'}" value="${escapeHtml(value)}" maxlength="200"${options.required === false ? '' : ' required'}>`}
  </div>`;
}

function scopeFields(draft) {
  return `<div class="field-grid">
    ${field('project', '项目', draft.project)}
    ${field('version', '台词版本', draft.version)}
    ${field('script', '台词正文', draft.script, { full: true, area: true })}
    ${field('usage', '用途与渠道', draft.usage, { full: true })}
  </div>`;
}

function detail(label, value, mono = false) {
  return `<div class="detail"><small>${label}</small><strong${mono ? ' class="mono"' : ''}>${escapeHtml(value)}</strong></div>`;
}

function documentPicker(type, selected, label) {
  const rows = documents(type).map(document => `<option value="${document.id}"${document.id === selected ? ' selected' : ''}>
    ${escapeHtml(document.scope?.version ? `${document.scope.version} · ${short(document.id)}` : short(document.id))}
  </option>`);
  const id = `pick-${type}`;
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">
    <option value="">请选择</option>${rows.join('')}
  </select></div>`;
}

function importControl(type, label) {
  return `<div class="field import-control"><label for="import-${type}">${label}</label>
    <input id="import-${type}" type="file" accept=".json,application/json">
  </div>`;
}

function uploadZone(id, label, file) {
  return `<div class="upload-zone" id="${id}-drop">
    <label for="${id}">${label}</label>
    <input id="${id}" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.opus,.webm">
    ${file ? `<p>当前文件 ${escapeHtml(file.name)}</p>` : '<p>也可以把音频拖到这里</p>'}
  </div>`;
}

function authorizationPage() {
  return `<div class="grid">
    <form class="card pad" id="authorize-form">
      <div class="card-title"><div><h2>签发授权单</h2><p>每次签发都会生成新的授权编号。</p></div></div>
      <div class="field-grid party-fields">
        ${isLocal() ? detail('签发人', DEMO_ACTOR) : detail('签发人', '提交时由钱包签名')}
        ${field('producer', isLocal() ? '获授权制作方' : '获授权制作方钱包地址', authDraft.producer)}
        ${field('validUntil', '有效期至（UTC）', authDraft.validUntil, { type: 'date', full: true })}
      </div>
      ${scopeFields(authDraft)}
      <div class="actions">
        <button class="btn copper" type="submit">签发授权</button>
        ${isLocal() ? '<button class="btn ghost" id="script-v2" type="button">填入第二版示例</button>' : ''}
      </div>
    </form>
    <aside class="rail"><section class="card pad">
      <div class="card-title"><div><h2>已签发授权</h2></div></div>
      ${documentPicker('authorization', authorization?.document.id, '选择授权单')}
      ${authorization ? `<div class="detail-grid">
        ${detail('状态', authorizationStatus(authorization.record))}
        ${detail('签发人', authorization.record.voiceActor)}
        ${detail('授权编号', authorization.document.id, true)}
        ${detail('制作方', authorization.record.producer)}
        ${detail('项目', authorization.document.scope.project)}
        ${detail('用途', authorization.document.scope.usage)}
        ${detail('有效期至', dateTime(authorization.record.validUntil))}
      </div>
      <div class="script-box review-script">
        <div class="script-meta">台词版本 ${escapeHtml(authorization.document.scope.version)}</div>
        <div class="script-text">${escapeHtml(authorization.document.scope.script)}</div>
      </div>
      <div class="actions">
        <button class="btn ghost" id="export-authorization">下载授权单</button>
        ${authorization.record.revoked ? '' : '<button class="btn ghost" id="revoke-authorization">撤销所选授权</button>'}
      </div>` : ''}
    </section></aside>
  </div>`;
}

function submissionPage() {
  return `<div class="grid">
    <form class="card pad" id="submit-form">
      <div class="card-title"><div><h2>成品送审</h2></div></div>
      ${documentPicker('authorization', authorization?.document.id, '关联授权单')}
      ${isLocal() ? `<div class="party-fields">${field('producer', '提交方', submitDraft.producer)}</div>` : ''}
      ${scopeFields(submitDraft)}
      ${uploadZone('submit-audio', '选择送审音频', pendingAudio?.file)}
      ${pendingAudio ? detail('SHA-256 文件指纹', pendingAudio.hash, true) : ''}
      <div class="actions"><button class="btn copper" type="submit">正式送审</button>
        ${isLocal() ? '<button class="btn ghost" id="load-sample" type="button">载入演示样音</button>' : ''}
      </div>
    </form>
    <aside class="rail"><section class="card pad">
      <div class="card-title"><div><h2>交接材料</h2></div></div>
      ${importControl('authorization', '导入配音员的授权单')}
      ${documents('submission').length ? `${documentPicker('submission', reviewCase?.document.id, '选择已送审记录')}
        ${reviewCase ? '<div class="actions"><button class="btn ghost" id="export-submission">下载送审单</button></div>' : ''}
        <p class="hint">将送审单和原始音频交给审核员。</p>` : ''}
    </section></aside>
  </div>`;
}

function reviewPage() {
  const current = reviewCase;
  const status = current?.decision?.decision;
  const approved = status === 'approved';
  return `<div class="grid">
    <section class="card pad">
      <div class="card-title"><div><h2>待审成品</h2></div></div>
      ${documentPicker('submission', current?.document.id, '选择送审记录')}
      ${current ? `<div class="detail-grid">
        ${detail('项目', current.document.scope.project)}
        ${detail('用途', current.document.scope.usage)}
        ${detail('授权人', current.grant.voiceActor)}
        ${detail('制作方', current.submission.producer)}
        ${detail('授权状态', authorizationStatus(current.grant))}
        ${detail('有效期至', dateTime(current.grant.validUntil))}
        ${detail('送审文件指纹', current.submission.fileHash, true)}
      </div>
      <div class="script-box review-script">
        <div class="script-meta">台词版本 ${escapeHtml(current.document.scope.version)}</div>
        <div class="script-text">${escapeHtml(current.document.scope.script)}</div>
      </div>
      ${reviewAudio ? `<audio controls preload="metadata" src="${mediaUrl}" aria-label="送审原音频"></audio>
        <p class="hint">已核对试听文件的指纹。${reviewAudio.name?.startsWith('演示样音-') ? '演示样音是提示声。' : ''}</p>`
        : uploadZone('review-audio', '导入送审原音频')}
      ${status ? `<div class="detail-grid">
        ${detail('审核决定', approved ? '已通过' : '已驳回')}${detail('审核人', current.decision.reviewer)}
      </div>${approved ? '<div class="actions"><button class="btn ghost" id="export-receipt">下载交付回执</button></div>' : ''}` : `
      <label class="review-confirm"><input type="checkbox" id="review-confirm"${reviewAudio ? '' : ' disabled'}> 已试听实际文件，并核对台词和用途</label>
      <div class="actions"><button class="btn copper" id="approve" disabled>通过并签发回执</button>
      <button class="btn ghost" id="reject" disabled>驳回</button></div>`}` : '<div class="empty">选择或导入一份送审单。</div>'}
    </section>
    <aside class="rail"><section class="card pad">
      <div class="card-title"><div><h2>接收制作方的材料</h2></div></div>
      ${importControl('submission', '导入制作方的送审单')}
      <p class="hint">审核员判断录音实际读了什么，以及成品是否符合授权用途。</p>
    </section></aside>
  </div>`;
}

function verdictMarkup() {
  if (!proof) return '';
  const { submission, grant, decision, matches } = proof;
  const active = authorizationStatus(grant);
  const approved = decision?.decision === 'approved';
  return `<div class="detail-grid">
    ${detail('回执编号', receipt.id, true)}
    ${detail('授权人', grant?.voiceActor ?? '未知')}
    ${detail('授权状态', active)}
    ${detail('审核人', decision?.reviewer ?? '尚未审核')}
    ${detail('审核决定', decision ? (approved ? '已通过' : '已驳回') : '待审核')}
    ${detail('审核时间', decision ? dateTime(decision.decidedAt) : '—')}
    ${detail('授权编号', submission.authorizationId, true)}
    ${detail('登记的文件指纹', submission.fileHash, true)}
    ${verifyAudio ? detail('收到的文件指纹', verifyAudio.hash, true) : ''}
  </div>${matches === null ? '' : `<div class="verify-result ${matches && approved && active === '有效' ? 'match' : 'mismatch'}" role="status">
    <h3>${matches ? '文件匹配' : '文件不匹配'}</h3>
    <p>${!matches ? '这份文件的指纹与回执关联的成品不同。' :
      approved && active === '有效' ? '文件指纹一致，审核已通过，授权当前有效。' :
      `文件指纹一致，当前审核${decision ? (approved ? '已通过' : '已驳回') : '未完成'}，授权${active}。`}</p>
  </div>`}`;
}

function verificationPage() {
  return `<div class="grid">
    <section class="card pad">
      <div class="card-title"><div><h2>回执与音频</h2></div></div>
      ${documentPicker('receipt', receipt?.id, '选择交付回执')}
      ${receipt ? uploadZone('verify-audio', '选择要核验的音频', verifyAudio?.file) : '<div class="empty">请选择或导入一份交付回执。</div>'}
      ${isLocal() && receipt ? `<div class="actions">
        <button class="btn ghost" id="verify-original">用送审原件核验</button>
        <button class="btn ghost" id="verify-other">用另一份样音核验</button>
      </div>` : ''}
      ${verdictMarkup()}
    </section>
    <aside class="rail"><section class="card pad">
      <div class="card-title"><div><h2>接收交付回执</h2></div></div>
      ${importControl('receipt', '导入审核方的回执')}
      <p class="hint">${isLocal() ? '当前使用浏览器本地账本。' : '使用配置的 Monad 合约查询，核验无需连接钱包。'}</p>
    </section></aside>
  </div>`;
}

function render() {
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = page === 'review' && reviewAudio ? URL.createObjectURL(reviewAudio) : null;
  const current = PAGES[page];
  const pages = { authorize: authorizationPage, submit: submissionPage, review: reviewPage, verify: verificationPage };
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">声</div><div class="brand-name">声证 / VOICE PROOF</div></div>
      <nav class="nav" aria-label="工作台">${Object.entries(PAGES).map(([key, item]) => `
        <button data-page="${key}" class="${key === page ? 'active' : ''}"${key === page ? ' aria-current="step"' : ''}>${item.label}</button>
      `).join('')}</nav>
      <div class="sidebar-spacer"></div>
      <div class="network-card"><div class="network-row"><span>当前账本</span><strong class="network-value">${networkLabel()}</strong></div></div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="crumb">工作台 / <strong>${current.role}</strong></div></header>
      <section class="content">
        <div class="page-head"><div><h1>${current.title}</h1><p class="lede">${current.description}</p></div></div>
        <details id="network-settings" class="network-settings"${configOpen ? ' open' : ''}>
          <summary>网络配置 · ${networkLabel()}</summary>
          <form id="network-form">
            <div class="field-grid">
              ${field('address', 'Monad 测试网合约地址', config.address, { prefix: 'network', required: false })}
              ${field('rpc', 'Monad 测试网 RPC', config.rpc, { prefix: 'network', required: false })}
            </div>
            <div class="actions"><button class="btn primary" type="submit">连接 Monad 测试网</button>
            <button class="btn ghost" id="use-local" type="button">使用本地演示</button></div>
          </form>
        </details>
        ${notice ? `<div class="notice ${notice.kind} feedback" role="${notice.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(notice.message)}</div>` : ''}
        ${pages[page]()}
      </section>
    </main>`;
  bindEvents();
}

async function run(task) {
  if (busy) return;
  busy = true;
  notice = null;
  app.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = true; });
  try {
    const message = await task();
    if (message) notice = { kind: 'info', message };
  } catch (error) {
    notice = { kind: 'error', message: error.reason ?? error.shortMessage ?? error.message };
  } finally {
    busy = false;
    render();
  }
}

async function changeNetwork(nextConfig) {
  config = nextConfig;
  const next = await openRegistry(nextConfig);
  registry.close?.();
  registry = next;
  prefs.config = config;
  savePrefs();
  resetWorkspace();
  return `已连接${networkLabel()}`;
}

function listen(id, event, callback) {
  document.getElementById(id)?.addEventListener(event, callback);
}

function bindPicker(type, select, clear) {
  listen(`pick-${type}`, 'change', event => run(() => {
    const item = documents(type).find(document => document.id === event.target.value);
    return item ? select(item) : clear();
  }));
  listen(`import-${type}`, 'change', event => {
    const file = event.target.files[0];
    if (file) run(async () => select(await importDocument(file, type)));
  });
}

function bindAudio(id, select) {
  listen(id, 'change', event => {
    const file = event.target.files[0];
    if (file) run(() => select(file));
  });
  listen(`${id}-drop`, 'dragover', event => {
    event.preventDefault();
    event.currentTarget.classList.add('dragover');
  });
  listen(`${id}-drop`, 'dragleave', event => event.currentTarget.classList.remove('dragover'));
  listen(`${id}-drop`, 'drop', event => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) run(() => select(file));
  });
}

function trackDraft(id, draft) {
  listen(id, 'input', event => {
    if (Object.hasOwn(draft, event.target.name)) draft[event.target.name] = event.target.value;
  });
}

function bindForm(id, action) {
  listen(id, 'submit', event => {
    event.preventDefault();
    run(() => action(event.target));
  });
}

function bindEvents() {
  app.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
    page = button.dataset.page;
    prefs.page = page;
    savePrefs();
    notice = null;
    render();
  }));
  listen('network-settings', 'toggle', event => {
    if (event.currentTarget.isConnected) configOpen = event.currentTarget.open;
  });
  bindForm('network-form', form => {
    const address = form.elements.address.value.trim();
    if (!address) throw new Error('请填写 Monad 测试网合约地址');
    const rpc = form.elements.rpc.value.trim() || DEFAULT_RPC;
    return changeNetwork({ address, rpc });
  });
  listen('use-local', 'click', () => run(() => changeNetwork({ address: '', rpc: DEFAULT_RPC })));

  bindPicker('authorization', selectAuthorization, () => { authorization = null; });
  bindPicker('submission', selectReview, () => { reviewCase = null; reviewAudio = null; });
  bindPicker('receipt', selectReceipt, () => { receipt = null; proof = null; verifyAudio = null; });
  trackDraft('authorize-form', authDraft);
  trackDraft('submit-form', submitDraft);
  bindForm('authorize-form', signAuthorization);
  bindForm('submit-form', submitForReview);
  listen('script-v2', 'click', () => {
    authDraft.version = 'v2';
    authDraft.script = DEMO_SCRIPTS.v2;
    render();
  });
  listen('export-authorization', 'click', () => download(authorization.document));
  listen('revoke-authorization', 'click', () => {
    if (window.confirm('撤销后无法使用这张授权继续送审。确认撤销？')) run(async () => {
      await registry.revoke(authorization.document.id);
      await selectAuthorization(authorization.document);
      return '已撤销授权';
    });
  });
  listen('export-submission', 'click', () => download(reviewCase.document));
  listen('export-receipt', 'click', () => download(handoff('receipt', reviewCase.document.id)));
  bindAudio('submit-audio', chooseSubmissionAudio);
  bindAudio('review-audio', attachReviewAudio);
  bindAudio('verify-audio', verifyFile);
  listen('load-sample', 'click', () => run(() => chooseSubmissionAudio(sampleAudio(submitDraft.version))));
  listen('verify-original', 'click', () => run(async () => {
    const file = await findAudio(receipt.id);
    if (!file) throw new Error('浏览器中没有送审原件，请导入收到的文件');
    await verifyFile(file);
  }));
  listen('verify-other', 'click', () => run(async () => {
    const details = await loadCase(receipt.id);
    const sample = sampleAudio('v2');
    const matches = await fingerprint(sample) === details.submission.fileHash;
    await verifyFile(matches ? sampleAudio('v1') : sample);
  }));
  listen('review-confirm', 'change', event => {
    const approved = document.getElementById('approve');
    approved.disabled = !event.target.checked || authorizationStatus(reviewCase.grant) !== '有效';
    document.getElementById('reject').disabled = !event.target.checked;
  });
  listen('approve', 'click', () => run(() => decide('approved')));
  listen('reject', 'click', () => run(() => decide('rejected')));
}

async function signAuthorization() {
  const scope = readScope(authDraft);
  const producer = authDraft.producer.trim();
  if (!producer || (!isLocal() && !isAddress(producer))) throw new Error('请填写有效的获授权制作方');
  const validUntil = Math.floor(Date.parse(`${authDraft.validUntil}T23:59:59Z`) / 1000);
  if (!Number.isFinite(validUntil) || validUntil <= Date.now() / 1000) throw new Error('请填写未来的有效期');
  const id = newId();
  const document = handoff('authorization', id, { scope });
  await registry.authorize(id, producer, await scopeHash(scope), validUntil);
  remember(document);
  await selectAuthorization(document);
  return '已签发授权单';
}

async function chooseSubmissionAudio(file) {
  pendingAudio = null;
  pendingAudio = { file, hash: await fingerprint(file) };
}

async function submitForReview() {
  if (!authorization) throw new Error('请先选择或导入授权单');
  const record = await registry.getAuthorization(authorization.document.id);
  requireActiveAuthorization(record);
  const scope = readScope(submitDraft);
  const hash = await scopeHash(scope);
  const producer = isLocal() ? submitDraft.producer.trim() : record.producer;
  if (isLocal() && record.producer !== producer) throw new Error('提交方与授权单不一致');
  if (record.scopeHash !== hash) throw new Error('项目、台词版本、台词正文或用途与授权单不一致');
  if (!pendingAudio) throw new Error('请先选择送审音频');
  const id = newId();
  const document = handoff('submission', id, { scope });
  await storeAudio(id, pendingAudio.file);
  try {
    await registry.submit(id, authorization.document.id, hash, pendingAudio.hash, producer);
  } catch (error) {
    if (isLocal()) await removeAudio(id);
    throw error;
  }
  remember(document);
  pendingAudio = null;
  await selectReview(document);
  return '已送审，文件指纹已登记';
}

async function attachReviewAudio(file) {
  const hash = await fingerprint(file);
  if (hash !== reviewCase.submission.fileHash) throw new Error('音频与送审记录的文件指纹不一致');
  await storeAudio(reviewCase.document.id, file);
  reviewAudio = file;
}

async function decide(decision) {
  if (!reviewCase || !reviewAudio) throw new Error('请先试听指纹匹配的送审音频');
  const { document } = reviewCase;
  await registry.decide(document.id, decision);
  if (decision === 'approved') remember(handoff('receipt', document.id));
  await selectReview(document);
  return decision === 'approved' ? '已通过，可下载交付回执' : '已驳回该成品';
}

async function verifyFile(file) {
  const document = receipt;
  proof = null;
  verifyAudio = null;
  const [hash, details] = await Promise.all([fingerprint(file), loadCase(document.id)]);
  verifyAudio = { file, hash };
  proof = { ...details, matches: hash === details.submission.fileHash };
}

resetWorkspace();
if (config.address) {
  try {
    registry = await openRegistry(config);
    resetWorkspace();
  } catch (error) {
    configOpen = true;
    notice = { kind: 'error', message: `无法恢复 Monad 连接。当前账本为本地演示。${error.message}` };
  }
}
render();
