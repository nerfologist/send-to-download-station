// Download Station client: everything that does not need the browser's extension APIs,
// so it runs unchanged in the service worker, in unit tests and in the smoke script.

export const AUTH_ERRORS = {
  400: 'wrong username or password',
  401: 'account disabled',
  402: 'permission denied',
  403: '2-factor code required: open the extension settings and click "Save & test"',
  404: '2-factor authentication failed',
  407: 'IP blocked by DSM auto-block',
};
export const TASK_ERRORS = {
  400: 'file upload failed',
  401: 'max number of tasks reached',
  402: 'destination denied',
  403: 'destination does not exist',
  406: 'no default destination set in Download Station',
  407: 'setting destination failed',
  408: 'file does not exist',
};
export const COMMON_ERRORS = {
  100: 'unknown error',
  101: 'invalid parameter',
  105: 'no permission (is the user allowed to use Download Station?)',
  106: 'session timeout',
  107: 'session interrupted by duplicate login',
  119: 'invalid session',
  120: 'invalid parameter',
};
export const SESSION_ERRORS = new Set([105, 106, 107, 119]);

export const DEVICE_NAME = 'Brave - Send to Download Station';

// How long a NAS request may take. Well under the 30 s after which the browser kills a
// service worker that is still waiting for a fetch, so the user gets a real error instead.
export const TIMEOUT_MS = 20_000;
// Anything larger is not a .torrent: stop downloading it.
export const MAX_TORRENT_BYTES = 10 * 1024 * 1024;

export class DsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function normalizeSettings(s) {
  return { ...s, nasUrl: (s.nasUrl || '').trim().replace(/\/+$/, '') };
}

export async function call(settings, path, body, errors) {
  let res;
  try {
    res = await fetch(`${settings.nasUrl}/webapi/${path}`, {
      method: 'POST',
      body,
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      throw new DsError(
        `NAS not reachable at ${settings.nasUrl} (no answer in ${TIMEOUT_MS / 1000} s): is it switched on?`
      );
    }
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

// With 2FA: the first login sends the OTP and asks DSM for a device token ("did");
// later logins present that token instead of a code. Returns {sid, did}; storing the
// device token is up to the caller.
export async function login(settings, otp) {
  if (!settings.nasUrl || !settings.username) {
    throw new DsError('not configured: open the extension settings');
  }
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
    Object.assign(params, { otp_code: otp, enable_device_token: 'yes', device_name: DEVICE_NAME });
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
  return { sid: data.sid, did: data.did || data.device_id || '' };
}

export async function logout(settings, sid) {
  const body = new URLSearchParams({
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'logout',
    session: 'DownloadStation',
    _sid: sid,
  });
  return call(settings, 'entry.cgi', body, AUTH_ERRORS);
}

// Runs fn(sid) with the cached session in state.sid; if that session turned out to be
// stale, logs in again once.
export async function withSession(state, settings, fn) {
  if (state.sid) {
    try {
      return await fn(state.sid);
    } catch (e) {
      if (!SESSION_ERRORS.has(e.code)) throw e;
      state.sid = null;
    }
  }
  state.sid = (await login(settings)).sid;
  return fn(state.sid);
}

// Follows the redirects recorded for url until it reaches a magnet link.
export function magnetFromRedirects(url, redirects) {
  for (let i = 0; i < 10 && url; i++) {
    if (/^magnet:/i.test(url)) return url;
    url = redirects.get(url);
  }
  return null;
}

export function torrentName(url, res) {
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

// Reads a response as a .torrent file without downloading more than needed: stops the
// download and returns null as soon as the first byte is not "d" (a .torrent is a bencoded
// dictionary) or the size passes MAX_TORRENT_BYTES.
export async function readTorrent(res) {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value.length) continue;
    const notTorrent = size === 0 && value[0] !== 0x64;
    size += value.length;
    if (notTorrent || size > MAX_TORRENT_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return size ? new Blob(chunks, { type: 'application/x-bittorrent' }) : null;
}

// Turns a link into either {uri} (magnet / plain URL) or {file, name} (.torrent contents).
// redirects is a Map the caller fills with the redirects it observes (fetch cannot follow a
// redirect to magnet:, so a Jackett link that ends in one surfaces as a network error).
export async function resolve(url, redirects = new Map()) {
  if (/^magnet:/i.test(url)) return { uri: url };
  redirects.clear();
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const file = await readTorrent(res);
      if (file) return { file, name: torrentName(url, res) };
    } else {
      res.body?.cancel().catch(() => {});
    }
  } catch {
    // Network error, or a redirect to magnet: (handled below).
  }
  const magnet = magnetFromRedirects(url, redirects);
  // Last resort: hand the URL to Download Station and let it fetch it itself.
  return { uri: magnet || url };
}

export function createTask(settings, item, sid) {
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
    return call(settings, `entry.cgi?_sid=${encodeURIComponent(sid)}`, body, TASK_ERRORS);
  }
  const fields = {
    api: 'SYNO.DownloadStation.Task',
    version: '3',
    method: 'create',
    _sid: sid,
    uri: item.uri,
  };
  if (settings.destination) fields.destination = settings.destination;
  return call(settings, 'DownloadStation/task.cgi', new URLSearchParams(fields), TASK_ERRORS);
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Resolves the link, adds it as a task and returns a description for the toast.
export async function send(state, settings, url, redirects) {
  const t0 = performance.now();
  const item = await resolve(url, redirects);
  const t1 = performance.now();
  let createMs = 0;
  const data = await withSession(state, settings, async (sid) => {
    const started = performance.now();
    try {
      return await createTask(settings, item, sid);
    } finally {
      createMs = performance.now() - started;
    }
  });
  // Everything since t1 minus the create call is login time.
  const loginMs = performance.now() - t1 - createMs;
  const parts = [];
  if (t1 - t0 > 50) parts.push(`fetch torrent ${secs(t1 - t0)}`);
  if (loginMs > 50) parts.push(`login ${secs(loginMs)}`);
  parts.push(`add task ${secs(createMs)}`);
  const what = item.file ? item.name : /^magnet:/i.test(item.uri) ? 'magnet link' : 'URL';
  return { message: `${what} to Download Station (${parts.join(', ')})`, item, data };
}
