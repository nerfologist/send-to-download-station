// Smoke test against a real NAS: adds a magnet link and a .torrent file through the same
// code the extension runs (lib/ds.js), checks that Download Station starts both, then
// deletes them. Run it after Download Station or DSM updates.
//
//   DS_URL=https://nas:5001 DS_USER=download_station DS_PASSWORD=... npm run smoke
//
// Optional: DS_DESTINATION (default: the user's default folder), DS_TORRENT_URL (a .torrent
// to upload), NODE_EXTRA_CA_CERTS=/path/to/rootCA.pem for a NAS with a private certificate.
import { randomBytes } from 'node:crypto';
import { call, logout, normalizeSettings, send } from '../lib/ds.js';

const env = process.env;
for (const k of ['DS_URL', 'DS_USER', 'DS_PASSWORD']) {
  if (!env[k]) {
    console.error(`Set ${k}. Usage: DS_URL=https://nas:5001 DS_USER=... DS_PASSWORD=... npm run smoke`);
    process.exit(2);
  }
}
const settings = normalizeSettings({
  nasUrl: env.DS_URL,
  username: env.DS_USER,
  password: env.DS_PASSWORD,
  destination: env.DS_DESTINATION || '',
});
const TORRENT_URL =
  env.DS_TORRENT_URL ||
  'https://archive.org/download/BigBuckBunny_124/BigBuckBunny_124_archive.torrent';
const TIMEOUT_MS = 60_000;

const state = { sid: null };
const created = [];
let failed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTasks() {
  const body = new URLSearchParams({
    api: 'SYNO.DownloadStation.Task',
    version: '1',
    method: 'list',
    additional: 'detail',
    _sid: state.sid,
  });
  return (await call(settings, 'DownloadStation/task.cgi', body, {})).tasks;
}

async function deleteTasks(ids) {
  const body = new URLSearchParams({
    api: 'SYNO.DownloadStation.Task',
    version: '1',
    method: 'delete',
    id: ids.join(','),
    _sid: state.sid,
  });
  return call(settings, 'DownloadStation/task.cgi', body, {});
}

// Waits until Download Station has picked the task up: "waiting" forever is the failure we
// have seen (a user without a default destination).
async function waitUntilStarted(label, match) {
  const deadline = Date.now() + TIMEOUT_MS;
  let task;
  while (Date.now() < deadline) {
    task = (await listTasks()).find(match);
    if (task && !created.includes(task.id)) created.push(task.id);
    if (task && !['waiting', 'error'].includes(task.status)) break;
    await sleep(2000);
  }
  if (!task) throw new Error(`${label}: task not found in the task list`);
  const dest = task.additional?.detail?.destination;
  if (task.status === 'waiting' || task.status === 'error') {
    throw new Error(`${label}: still "${task.status}" after ${TIMEOUT_MS / 1000} s`);
  }
  if (settings.destination && dest !== settings.destination) {
    throw new Error(`${label}: saved to "${dest}", expected "${settings.destination}"`);
  }
  return `${task.status}, saved to ${dest}`;
}

async function step(label, fn) {
  try {
    console.log(`ok    ${label}: ${await fn()}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL  ${label}: ${e.message}`);
  }
}

try {
  await step('magnet link', async () => {
    // A random info hash: it has no peers, but Download Station must still start it.
    const title = `smoke-test-${randomBytes(4).toString('hex')}`;
    const magnet = `magnet:?xt=urn:btih:${randomBytes(20).toString('hex')}&dn=${title}`;
    await send(state, settings, magnet, new Map());
    return waitUntilStarted('magnet link', (t) => t.title === title);
  });

  await step('.torrent upload', async () => {
    const { item, data } = await send(state, settings, TORRENT_URL, new Map());
    if (!item.file) throw new Error(`${TORRENT_URL} did not download as a .torrent file`);
    const [id] = data?.task_id || [];
    if (!id) throw new Error(`Download Station accepted the upload but created no task`);
    created.push(id);
    return waitUntilStarted('.torrent upload', (t) => t.id === id);
  });
} finally {
  if (state.sid) {
    if (created.length) await deleteTasks(created).catch((e) => console.log(`cleanup failed: ${e.message}`));
    await logout(settings, state.sid).catch(() => {});
  }
}

console.log(failed ? '\nSmoke test FAILED' : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
