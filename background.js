import { login, logout, normalizeSettings, recordRedirect, send, storedState } from './lib/ds.js';

const DEFAULTS = {
  nasUrl: '',
  username: '',
  password: '',
  destination: '',
  intercept: true,
  deviceId: '',
};

// Cached DSM session id; reset when the settings change. Kept in session storage (memory
// only, not readable by content scripts) so it survives the worker going to sleep.
const state = storedState(chrome.storage.session);

async function getSettings() {
  return normalizeSettings(await chrome.storage.local.get(DEFAULTS));
}

// Redirects seen on requests made by this extension. Lets us recover the magnet
// link when a Jackett /dl/ URL redirects to magnet: (fetch can't follow that).
const redirects = new Map();
chrome.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (d.tabId === -1 && d.initiator === `chrome-extension://${chrome.runtime.id}`) {
      recordRedirect(redirects, d.url, d.redirectUrl);
    }
  },
  { urls: ['<all_urls>'] }
);

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
  if (state.sid) await logout(settings, state.sid).catch(() => {}); // best effort
  state.sid = null;
  await chrome.storage.local.set({ password: '', deviceId: '' });
  setStatus('unknown');
  return { ok: true, message: 'Disconnected' };
}

async function handle(msg) {
  await state.ready;
  if (msg.type === 'disconnect') return disconnect();
  const result = await handleInner(msg);
  setStatus(result.ok ? 'ok' : 'error', result.ok ? '' : result.message);
  return result;
}

async function handleInner(msg) {
  try {
    if (msg.type === 'send') {
      const { message } = await send(state, await getSettings(), msg.url, redirects);
      return { ok: true, message: `Added ${message}` };
    }
    if (msg.type === 'test') {
      state.sid = null;
      const { sid, did } = await login(await getSettings(), msg.otp);
      state.sid = sid;
      if (msg.otp) {
        if (!did) {
          return {
            ok: false,
            message: 'login OK, but DSM returned no device token, so the 2FA code will be needed again',
          };
        }
        await chrome.storage.local.set({ deviceId: did });
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
  if (changes.nasUrl || changes.username || changes.password) state.sid = null;
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
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['lib/links.js', 'content.js'],
          })
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
