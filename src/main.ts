import './style.css';
import { type ApiErrorBody, type CreateUpload, type PublicConfig, type UploadResult, type UploadSession } from '../shared/contracts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
let config: PublicConfig | undefined;
let currentTab: 'download' | 'upload' = 'download';
let downloadBusy = false;
let authBusy = false;
let uploadBusy = false;
let uploadBlockedUntil = 0;
let downloadBlockedUntil = 0;
let selectedFile: File | null = null;
let completed = false;

interface UploadJob {
  file: File;
  settings: CreateUpload;
  session?: UploadSession;
  bytes: number[];
  finished: Set<number>;
  controller: AbortController;
  cancelled: boolean;
}
let job: UploadJob | undefined;

class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(errorMessage(body)); }
}

function errorMessage(body: ApiErrorBody) {
  if (body.error === 'SITE_QUOTA_EXCEEDED' && body.retryAfter) {
    const reset = new Date(Date.now() + body.retryAfter * 1000).toLocaleString('zh-CN');
    return `${body.message}恢复时间：${reset}。`;
  }
  return body.message;
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ApiError(response.status, { error: 'NETWORK_ERROR', message: '暂时无法连接服务，请稍后重试。' }); }
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as T;
}

const post = <T>(url: string, body: unknown, options: RequestInit = {}) => api<T>(url, { ...options, method: 'POST', body: JSON.stringify(body) });
const remaining = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / 1000));
const message = (id: string, text: string, kind = '') => {
  const node = el(id);
  node.textContent = text;
  node.className = `notice ${kind}`;
  node.hidden = !text;
};
const describe = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const bytesLabel = (size: number) => size < 1000 ? `${size} B` : size < 1_000_000 ? `${(size / 1000).toFixed(1)} KB` : `${(size / 1_000_000).toFixed(1)} MB`;

function updateControls() {
  const downloadWait = remaining(downloadBlockedUntil);
  const authWait = remaining(uploadBlockedUntil);
  button('download-button').disabled = !config || downloadBusy || downloadWait > 0;
  button('download-button').querySelector('span')!.textContent = downloadWait ? `${downloadWait} 秒后重试` : downloadBusy ? '正在准备下载…' : '接收文件';
  button('auth-button').disabled = !config?.uploadConfigured || authBusy || authWait > 0;
  button('auth-button').querySelector('span')!.textContent = authWait ? `${authWait} 秒后重试` : authBusy ? '正在验证…' : '验证并继续';
  button('google-button').disabled = !config?.uploadConfigured || authBusy || authWait > 0;
  button('google-button').querySelector('span')!.textContent = authWait ? `${authWait} 秒后重试` : authBusy ? '正在前往 Google…' : '使用 Google 账号登录';
  button('logout-button').disabled = uploadBusy || !!job?.session;
  button('upload-button').disabled = uploadBusy || !config;
  button('upload-button').querySelector('span')!.textContent = uploadBusy ? '正在投送…' : job?.session ? '重试投送' : '开始投送';
  el<HTMLFieldSetElement>('upload-fields').disabled = uploadBusy || !!job?.session;
  button('cancel-upload').hidden = !uploadBusy && !job?.session;
  button('cancel-upload').disabled = !!job?.cancelled;
}

function renderPanels() {
  el('download-panel').hidden = !config || currentTab !== 'download';
  el('upload-panel').hidden = !config || currentTab !== 'upload';
  if (config) {
    const needAuth = config.uploadAuthMode !== 'none' && !config.uploadAuthenticated;
    el('auth-form').hidden = !needAuth || config.uploadAuthMode !== 'password' || completed;
    el('google-auth').hidden = !needAuth || config.uploadAuthMode !== 'google' || completed;
    el('google-session').hidden = config.uploadAuthMode !== 'google' || !config.uploadAuthenticated;
    el('google-email').textContent = config.uploadEmail ?? '';
    el('upload-form').hidden = needAuth || completed;
    el('upload-success').hidden = !completed;
    if (!config.uploadConfigured) message(config.uploadAuthMode === 'google' ? 'google-message' : 'auth-message', '上传验证尚未配置，请联系管理员。', 'error');
  }
  updateControls();
}

function switchTab(tab: typeof currentTab) {
  currentTab = tab;
  for (const name of ['download', 'upload'] as const) {
    const node = button(`${name}-tab`);
    node.classList.toggle('active', name === tab);
    node.setAttribute('aria-selected', String(name === tab));
    node.tabIndex = name === tab ? 0 : -1;
  }
  renderPanels();
}

for (const tab of ['download', 'upload'] as const) {
  button(`${tab}-tab`).addEventListener('click', () => switchTab(tab));
  button(`${tab}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'download' : event.key === 'End' ? 'upload' : currentTab === 'download' ? 'upload' : 'download';
      switchTab(next); button(`${next}-tab`).focus();
    }
  });
}

function randomCode() {
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4_200_000_000);
  input('send-code').value = String(random[0] % 100_000_000).padStart(8, '0');
}
button('generate-code').addEventListener('click', randomCode);

async function loadConfig() {
  const initial = !config;
  if (initial) el('loading').hidden = false;
  message('config-error', '');
  button('reload-config').hidden = true;
  try {
    config = await api<PublicConfig>('/api/config');
    uploadBlockedUntil = Date.now() + Math.max(0, config.uploadBlockedUntil - config.serverTime);
    downloadBlockedUntil = Date.now() + Math.max(0, config.downloadBlockedUntil - config.serverTime);
    if (initial) {
      input('download-limit').value = String(config.defaultDownloads);
      input('download-limit').max = String(config.maxDownloads);
      input('custom-ttl').max = String(Math.floor(config.maxTtlSeconds / 60));
      el('ttl-range').textContent = `最多 ${Math.floor(config.maxTtlSeconds / 60)} 分钟`;
      const ttl = el<HTMLSelectElement>('ttl');
      for (const option of Array.from(ttl.options)) {
        if (option.value !== 'custom' && Number(option.value) > config.maxTtlSeconds) option.remove();
      }
      const value = String(config.defaultTtlSeconds);
      if (Array.from(ttl.options).some(option => option.value === value)) ttl.value = value;
      else { ttl.value = 'custom'; input('custom-ttl').value = String(Math.ceil(config.defaultTtlSeconds / 60)); }
      el('custom-ttl-field').hidden = ttl.value !== 'custom';
      randomCode();
    }
    renderPanels();
    if (initial && location.hash === '#upload') switchTab('upload');
    if (initial && new URLSearchParams(location.search).has('auth')) {
      const reason = new URLSearchParams(location.search).get('auth');
      const notices: Record<string, string> = { denied: '此账号没有上传权限，或登录尝试过于频繁。请等待倒计时结束后重试。', expired: '登录请求已失效，请重新登录。', cancelled: '已取消 Google 登录。', unavailable: 'Google 登录暂时不可用，请稍后重试。' };
      message('google-message', notices[reason ?? ''] ?? notices.expired, 'error');
      history.replaceState(null, '', '/#upload');
    }
  } catch (error) {
    if (initial) { message('config-error', describe(error), 'error'); button('reload-config').hidden = false; }
  } finally { el('loading').hidden = true; }
}
button('reload-config').addEventListener('click', () => void loadConfig());
window.addEventListener('focus', () => { if (!uploadBusy) void loadConfig(); });

button('google-button').addEventListener('click', async () => {
  if (authBusy || remaining(uploadBlockedUntil) || !config?.uploadConfigured) return;
  if (config.googleLoginOrigin && config.googleLoginOrigin !== location.origin) {
    location.assign(`${config.googleLoginOrigin}/#upload`); return;
  }
  authBusy = true; updateControls(); message('google-message', '');
  try {
    const { url } = await post<{ url: string }>('/api/auth/google/start', {});
    location.assign(url);
  } catch (error) { setLock(error, 'upload'); message('google-message', describe(error), 'error'); authBusy = false; updateControls(); }
});
button('logout-button').addEventListener('click', async () => {
  try { await post('/api/auth/logout', {}); completed = false; await loadConfig(); }
  catch (error) { message('upload-message', describe(error), 'error'); }
});

function setLock(error: unknown, kind: 'upload' | 'download') {
  if (error instanceof ApiError && error.body.error === 'LOCKED' && error.body.retryAfter) {
    const until = Date.now() + error.body.retryAfter * 1000;
    if (kind === 'upload') uploadBlockedUntil = until; else downloadBlockedUntil = until;
  }
}

el<HTMLFormElement>('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (authBusy || remaining(uploadBlockedUntil)) return;
  authBusy = true; updateControls(); message('auth-message', '');
  try {
    await post('/api/upload-auth', { password: input('upload-password').value });
    input('upload-password').value = '';
    config!.uploadAuthenticated = true;
    renderPanels();
  } catch (error) { setLock(error, 'upload'); message('auth-message', describe(error), 'error'); }
  finally { authBusy = false; updateControls(); }
});

el<HTMLFormElement>('download-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (downloadBusy || remaining(downloadBlockedUntil)) return;
  downloadBusy = true; updateControls(); message('download-message', '');
  try {
    const { ticket } = await post<{ ticket: string }>('/api/downloads/prepare', { code: input('receive-code').value });
    el<HTMLIFrameElement>('download-frame').src = `/api/downloads/${encodeURIComponent(ticket)}`;
    message('download-message', '已发起下载，请在浏览器的下载列表中查看。');
  } catch (error) { setLock(error, 'download'); message('download-message', describe(error), 'error'); }
  finally { downloadBusy = false; updateControls(); }
});

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== el<HTMLIFrameElement>('download-frame').contentWindow || event.data?.type !== 'lite-drop:download-error') return;
  const payload = event.data.payload as ApiErrorBody;
  if (payload.error === 'LOCKED' && payload.retryAfter) downloadBlockedUntil = Date.now() + payload.retryAfter * 1000;
  message('download-message', errorMessage(payload) || '下载未能开始，请重试。', 'error'); updateControls();
});

el<HTMLSelectElement>('ttl').addEventListener('change', () => {
  const custom = el<HTMLSelectElement>('ttl').value === 'custom';
  el('custom-ttl-field').hidden = !custom;
  input('custom-ttl').required = custom;
});

function chooseFile(file: File | undefined) {
  if (uploadBusy || job?.session || !file) return;
  if (file.size > (config?.maxFileSize ?? 500_000_000)) {
    message('upload-message', '这个文件超过了 500 MB，请选择更小的文件。', 'error');
    input('file-input').value = ''; return;
  }
  selectedFile = file;
  el('file-title').textContent = file.name;
  el('file-detail').textContent = bytesLabel(file.size);
  el('file-change').hidden = false;
  message('upload-message', '');
}
input('file-input').addEventListener('change', () => chooseFile(input('file-input').files?.[0]));
const dropZone = el('drop-zone');
for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, event => { event.preventDefault(); if (!uploadBusy && !job?.session) dropZone.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', event => {
  const files = (event as DragEvent).dataTransfer?.files;
  if (files && files.length !== 1) message('upload-message', '每次只投送一个文件。多个文件请先打包。', 'error');
  else chooseFile(files?.[0]);
});

function updateProgress(current: UploadJob, stage = '正在上传') {
  if (job !== current) return;
  const sent = current.bytes.reduce((sum, value) => sum + value, 0);
  const percent = current.file.size ? Math.min(100, Math.round(sent / current.file.size * 100)) : (current.finished.size ? 100 : 0);
  el('progress-area').hidden = false;
  el('progress-label').textContent = stage;
  el('progress-percent').textContent = `${percent}%`;
  el<HTMLProgressElement>('upload-progress').value = percent;
  el('progress-detail').textContent = `${bytesLabel(sent)} / ${bytesLabel(current.file.size)} · 请保持页面打开`;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sendPart(current: UploadJob, number: number) {
  const session = current.session!;
  const blob = current.file.slice((number - 1) * session.partSize, number * session.partSize);
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const signal = current.controller.signal;
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    xhr.open('PUT', `/api/uploads/${session.id}/parts/${number}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.upload.onprogress = event => { current.bytes[number - 1] = Math.min(event.loaded, blob.size); updateProgress(current); };
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { current.bytes[number - 1] = blob.size; current.finished.add(number); resolve(); }
      else reject(new ApiError(xhr.status, xhr.response || { error: 'UPLOAD_ERROR', message: '分片上传失败，请重试。' }));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'NETWORK_ERROR', message: '网络连接中断，可重试继续上传。' }));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(blob);
  });
}

async function retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      const retryable = error instanceof ApiError ? error.status === 0 || error.status === 409 || error.status >= 500 : error instanceof TypeError;
      if (!retryable || attempt >= 3) throw error;
      await wait(Math.max(1000 * 2 ** attempt, error instanceof ApiError ? (error.body.retryAfter ?? 0) * 1000 : 0), signal);
    }
  }
}

async function cleanCancelled(current: UploadJob) {
  if (current.session) {
    await api(`/api/uploads/${current.session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${current.session.token}` } });
  }
}

el<HTMLFormElement>('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (uploadBusy) return;
  if (!selectedFile) { message('upload-message', '请先选择一个文件。', 'error'); return; }
  if (!job) {
    const ttl = el<HTMLSelectElement>('ttl').value;
    job = {
      file: selectedFile, settings: { name: selectedFile.name, size: selectedFile.size, code: input('send-code').value,
        ttlSeconds: ttl === 'custom' ? Number(input('custom-ttl').value) * 60 : Number(ttl), downloads: Number(input('download-limit').value) },
      bytes: [], finished: new Set(), controller: new AbortController(), cancelled: false,
    };
  } else job.controller = new AbortController();
  const current = job;
  uploadBusy = true; updateControls(); message('upload-message', ''); updateProgress(current, '正在准备投送');
  try {
    if (!current.session) {
      // Let initialization finish after a cancel so we can clean its allocated upload.
      current.session = await post<UploadSession>('/api/uploads', current.settings);
      current.bytes = Array(current.session.partCount).fill(0);
    }
    if (current.cancelled) throw new DOMException('Aborted', 'AbortError');
    let next = 1;
    const worker = async () => {
      while (next <= current.session!.partCount) {
        const number = next++;
        if (current.finished.has(number)) continue;
        await retry(() => sendPart(current, number), current.controller.signal);
        updateProgress(current);
      }
    };
    let firstError: unknown;
    const workers = Array.from({ length: Math.min(3, current.session.partCount) }, () => worker().catch(error => {
      firstError ??= error;
      current.controller.abort();
    }));
    await Promise.all(workers);
    if (firstError) throw firstError;
    if (current.cancelled) throw new DOMException('Aborted', 'AbortError');
    updateProgress(current, '正在校验并完成投送');
    const result = await retry(() => post<UploadResult>(`/api/uploads/${current.session!.id}/complete`, {}, {
      headers: { Authorization: `Bearer ${current.session!.token}` },
    }), current.controller.signal);
    if (current.cancelled) throw new DOMException('Aborted', 'AbortError');
    completed = true;
    el('success-name').textContent = `${result.name} · ${bytesLabel(result.size)}`;
    el('success-code').textContent = current.settings.code;
    el('success-expiry').textContent = `有效至 ${new Date(result.expiresAt).toLocaleString('zh-CN', { hour12: false })}`;
    el('success-count').textContent = `可下载 ${result.downloads} 次`;
    job = undefined;
    renderPanels();
  } catch (error) {
    if (current.cancelled) {
      try { await cleanCancelled(current); message('upload-message', '已取消投送，文件正在清理。'); }
      catch { message('upload-message', '已停止上传。暂时无法连接清理服务，残留上传会在 24 小时后自动清理。', 'warn'); }
      job = undefined; el('progress-area').hidden = true;
    } else {
      message('upload-message', describe(error), 'error');
      if (!current.session) job = undefined;
      if (error instanceof ApiError && error.status === 401) { config!.uploadAuthenticated = false; renderPanels(); }
    }
  } finally { uploadBusy = false; updateControls(); }
});

button('cancel-upload').addEventListener('click', async () => {
  if (!job || job.cancelled) return;
  const current = job;
  current.cancelled = true; current.controller.abort(); updateControls();
  el('progress-label').textContent = '正在取消投送…';
  if (!uploadBusy) {
    try { await cleanCancelled(current); message('upload-message', '已取消投送，文件正在清理。'); }
    catch { message('upload-message', '已停止上传，残留上传会在 24 小时后自动清理。', 'warn'); }
    job = undefined; el('progress-area').hidden = true; updateControls();
  }
});

button('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el('success-code').textContent!); button('copy-code').textContent = '已复制 ✓'; }
  catch { button('copy-code').textContent = '请长按接收码复制'; }
});
button('another-upload').addEventListener('click', () => {
  completed = false; selectedFile = null; input('file-input').value = ''; randomCode();
  el('file-title').textContent = '点击选择，或拖入文件'; el('file-detail').textContent = '单个文件 · 最大 500 MB';
  el('file-change').hidden = true; el('progress-area').hidden = true;
  message('upload-message', ''); button('copy-code').textContent = '复制接收码'; renderPanels();
});
window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });
setInterval(updateControls, 250);
void loadConfig();
