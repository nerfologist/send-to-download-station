const DEFAULTS = {
  nasUrl: '',
  username: '',
  password: '',
  destination: '',
  intercept: true,
  deviceId: '',
};

const AUTH_ERRORS = {
  400: 'wrong username or password',
  401: 'account disabled',
  402: 'permission denied',
  403: '2-factor code required — open the extension settings and click "Save & test"',
  404: '2-factor authentication failed',
  407: 'IP blocked by DSM auto-block',
};
const TASK_ERRORS = {
  400: 'file upload failed',
  401: 'max number of tasks reached',
  402: 'destination denied',
  403: 'destination does not exist',
  406: 'no default destination set in Download Station',
  407: 'setting destination failed',
  408: 'file does not exist',
};
const COMMON_ERRORS = {
  100: 'unknown error',
  101: 'invalid parameter',
  105: 'no permission (is the user allowed to use Download Station?)',
  106: 'session timeout',
  107: 'session interrupted by duplicate login',
  119: 'invalid session',
};
const SESSION_ERRORS = new Set([105, 106, 107, 119]);

let sid = null;

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  s.nasUrl = s.nasUrl.trim().replace(/\/+$/, '');
  return s;
}

class DsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function call(settings, path, body, errors) {
  let res;
  try {
    res = await fetch(`${settings.nasUrl}/webapi/${path}`, {
      method: 'POST',
      body,
      credentials: 'omit',
    });
  } catch (e) {
    throw new DsError(`cannot reach ${settings.nasUrl} (${e.message})`);
  }
  if (!res.ok) throw new DsError(`NAS answered HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) {
    const code = json.error?.code;
    throw new DsError(errors[code] || COMMON_ERRORS[code] || `error code ${code}`, code);
  }
  return json.data;
}

const DEVICE_NAME = 'Brave - Send to Download Station';

// With 2FA: the first login sends the OTP and asks DSM for a device token ("did");
// later logins present that token instead of a code.
async function login(settings, otp) {
  if (!settings.nasUrl || !settings.username) throw new DsError('not configured — open the extension settings');
  const params = {
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'login',
    account: settings.username,
    passwd: settings.password,
    session: 'DownloadStation',
    format: 'sid',
  };
  if (otp) {
    Object.assign(params, {
      otp_code: otp,
      enable_device_token: 'yes',
      device_name: DEVICE_NAME,
    });
  } else if (settings.deviceId) {
    Object.assign(params, { device_id: settings.deviceId, device_name: DEVICE_NAME });
  }
  let data;
  try {
    data = await call(settings, 'entry.cgi', new URLSearchParams(params), AUTH_ERRORS);
  } catch (e) {
    // 403 = code required, 404 = code wrong: the settings page prompts for it.
    if (e.code === 403 || e.code === 404) e.needOtp = true;
    throw e;
  }
  const did = data.did || data.device_id;
  if (otp && did) await chrome.storage.local.set({ deviceId: did });
  sid = data.sid;
  return sid;
}

// Runs fn(sid); if the cached session turned out to be stale, logs in again once.
async function withSession(settings, fn) {
  if (sid) {
    try {
      return await fn(sid);
    } catch (e) {
      if (!SESSION_ERRORS.has(e.code)) throw e;
      sid = null;
    }
  }
  return fn(await login(settings));
}

// Redirects seen on requests made by this extension. Lets us recover the magnet
// link when a Jackett /dl/ URL redirects to magnet: (fetch can't follow that).
const redirects = new Map();
chrome.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (d.tabId === -1 && d.initiator === `chrome-extension://${chrome.runtime.id}`) {
      redirects.set(d.url, d.redirectUrl);
    }
  },
  { urls: ['<all_urls>'] }
);

function magnetFromRedirects(url) {
  for (let i = 0; i < 10 && url; i++) {
    if (/^magnet:/i.test(url)) return url;
    url = redirects.get(url);
  }
  return null;
}

function torrentName(url, res) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  let name = m ? m[1] : '';
  if (!name) {
    const u = new URL(url);
    name = u.searchParams.get('file') || u.pathname.split('/').pop() || '';
  }
  try {
    name = decodeURIComponent(name);
  } catch {}
  name = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
  return /\.torrent$/i.test(name) ? name : `${name}.torrent`;
}

// Turns a link into either {uri} (magnet / plain URL) or {file, name} (.torrent contents).
async function resolve(url) {
  if (/^magnet:/i.test(url)) return { uri: url };
  redirects.clear();
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A .torrent is a bencoded dictionary: starts with "d".
      if (bytes.length > 0 && bytes[0] === 0x64) {
        return {
          file: new Blob([bytes], { type: 'application/x-bittorrent' }),
          name: torrentName(url, res),
        };
      }
    }
  } catch {
    // Network error, or a redirect to magnet: — handled below.
  }
  const magnet = magnetFromRedirects(url);
  // Last resort: hand the URL to Download Station and let it fetch it itself.
  return { uri: magnet || url };
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function send(url) {
  const settings = await getSettings();
  const t0 = performance.now();
  const item = await resolve(url);
  const t1 = performance.now();
  let loginMs = 0;
  let createMs = 0;
  await withSession(settings, async (s) => {
    // First call after a (re)login: everything since t1 minus the create call is login time.
    const started = performance.now();
    try {
      return await create(settings, item, s);
    } finally {
      createMs = performance.now() - started;
    }
  });
  loginMs = performance.now() - t1 - createMs;
  const parts = [];
  if (t1 - t0 > 50) parts.push(`fetch torrent ${secs(t1 - t0)}`);
  if (loginMs > 50) parts.push(`login ${secs(loginMs)}`);
  parts.push(`add task ${secs(createMs)}`);
  const what = item.file ? item.name : /^magnet:/i.test(item.uri) ? 'magnet link' : 'URL';
  return `${what} to Download Station (${parts.join(', ')})`;
}

function create(settings, item, s) {
  if (item.file) {
    // .torrent uploads go through the DownloadStation2 API, the one DSM's own UI uses:
    // the legacy task.cgi upload answers "invalid parameter" (101) on current Download
    // Station versions. DS2 wants JSON-encoded values and the session id in the query
    // string (in the multipart body it answers "invalid session"). An empty destination
    // means the user's default folder.
    const body = new FormData();
    body.append('api', 'SYNO.DownloadStation2.Task');
    body.append('version', '2');
    body.append('method', 'create');
    body.append('type', '"file"');
    body.append('file', '["torrent"]');
    body.append('destination', JSON.stringify(settings.destination || ''));
    body.append('create_list', 'false');
    body.append('torrent', item.file, item.name); // must be the last part
    return call(settings, `entry.cgi?_sid=${encodeURIComponent(s)}`, body, TASK_ERRORS);
  }
  const fields = {
    api: 'SYNO.DownloadStation.Task',
    version: '3',
    method: 'create',
    _sid: s,
    uri: item.uri,
  };
  if (settings.destination) fields.destination = settings.destination;
  return call(settings, 'DownloadStation/task.cgi', new URLSearchParams(fields), TASK_ERRORS);
}

// Toolbar icon: grey = not connected yet, green = last NAS call worked, red = it failed.
const ICON_COLORS = { unknown: '#8a8a8a', ok: '#2e9d48', error: '#d32f2f' };

function drawIcon(size, color) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const u = size / 16;
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, size, size, 3.5 * u);
  g.fill();
  // White "download" arrow over a tray line.
  g.strokeStyle = '#fff';
  g.lineWidth = 2 * u;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(8 * u, 3 * u);
  g.lineTo(8 * u, 9.5 * u);
  g.moveTo(4.8 * u, 6.5 * u);
  g.lineTo(8 * u, 9.7 * u);
  g.lineTo(11.2 * u, 6.5 * u);
  g.moveTo(4 * u, 13 * u);
  g.lineTo(12 * u, 13 * u);
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

function applyStatus(status, detail) {
  const color = ICON_COLORS[status] || ICON_COLORS.unknown;
  chrome.action.setIcon({ imageData: { 16: drawIcon(16, color), 32: drawIcon(32, color) } });
  const label = { ok: 'connected', error: detail || 'error', unknown: 'not connected' }[status];
  chrome.action.setTitle({ title: `Send to Download Station — ${label}` });
}

function setStatus(status, detail = '') {
  applyStatus(status, detail);
  chrome.storage.local.set({ status, statusDetail: detail });
}

// Icons set at runtime don't survive a browser restart; restore on every worker start.
chrome.storage.local
  .get({ status: 'unknown', statusDetail: '' })
  .then((s) => applyStatus(s.status, s.statusDetail));

// Ends the DSM session and forgets the password and trusted-device token.
async function disconnect() {
  const settings = await getSettings();
  if (sid) {
    await call(
      settings,
      'entry.cgi',
      new URLSearchParams({
        api: 'SYNO.API.Auth',
        version: '6',
        method: 'logout',
        session: 'DownloadStation',
        _sid: sid,
      }),
      AUTH_ERRORS
    ).catch(() => {}); // best effort
  }
  sid = null;
  await chrome.storage.local.set({ password: '', deviceId: '' });
  setStatus('unknown');
  return { ok: true, message: 'Disconnected' };
}

async function handle(msg) {
  if (msg.type === 'disconnect') return disconnect();
  const result = await handleInner(msg);
  setStatus(result.ok ? 'ok' : 'error', result.ok ? '' : result.message);
  return result;
}

async function handleInner(msg) {
  try {
    if (msg.type === 'send') {
      const what = await send(msg.url);
      return { ok: true, message: `Added ${what}` };
    }
    if (msg.type === 'test') {
      sid = null;
      await login(await getSettings(), msg.otp);
      const { deviceId } = await chrome.storage.local.get({ deviceId: '' });
      if (msg.otp && !deviceId) {
        return { ok: false, message: 'login OK, but DSM returned no device token — 2FA code will be needed again' };
      }
      return { ok: true, message: 'Login OK' };
    }
    return { ok: false, message: 'unknown request' };
  } catch (e) {
    return { ok: false, message: `Download Station: ${e.message}`, needOtp: !!e.needOtp };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // async response
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.nasUrl || changes.username || changes.password) sid = null;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: 'send-to-ds',
    title: 'Send link to Download Station',
    contexts: ['link'],
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  // Tabs that were already open don't have the content script (or have an orphaned
  // one after an extension reload): inject it so they work without a page reload.
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then((tabs) => {
      for (const tab of tabs) {
        chrome.scripting
          .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
          .catch(() => {}); // restricted pages
      }
    });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'send-to-ds' || !info.linkUrl) return;
  const toast = (payload) =>
    tab?.id != null &&
    chrome.tabs.sendMessage(tab.id, { type: 'toast', ...payload }).catch(() => {});
  toast({ ok: true, message: 'Sending to Download Station…', pending: true });
  const result = await handle({ type: 'send', url: info.linkUrl });
  toast(result);
  chrome.action.setBadgeBackgroundColor({ color: result.ok ? '#2e7d32' : '#c62828' });
  chrome.action.setBadgeText({ text: result.ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
