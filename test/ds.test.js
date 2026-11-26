import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  call,
  createTask,
  DsError,
  login,
  magnetFromRedirects,
  normalizeSettings,
  resolve,
  send,
  TASK_ERRORS,
  TIMEOUT_MS,
  torrentName,
  withSession,
} from '../lib/ds.js';

const SETTINGS = { nasUrl: 'https://nas:5001', username: 'dl', password: 'pw', destination: '' };
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x';

const ok = (data) => new Response(JSON.stringify({ success: true, data }));
const fail = (code) => new Response(JSON.stringify({ success: false, error: { code } }));

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('normalizeSettings', () => {
  it('trims the address and drops trailing slashes', () => {
    expect(normalizeSettings({ nasUrl: ' https://nas:5001// ' }).nasUrl).toBe('https://nas:5001');
  });
});

describe('call', () => {
  it('returns data on success', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 'abc' }));
    await expect(call(SETTINGS, 'entry.cgi', null, {})).resolves.toEqual({ sid: 'abc' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://nas:5001/webapi/entry.cgi');
  });

  it('maps API-specific error codes first', async () => {
    fetchMock.mockResolvedValue(fail(406));
    await expect(call(SETTINGS, 'x', null, TASK_ERRORS)).rejects.toMatchObject({
      message: 'no default destination set in Download Station',
      code: 406,
    });
  });

  it('falls back to common and then to raw error codes', async () => {
    fetchMock.mockResolvedValueOnce(fail(101)).mockResolvedValueOnce(fail(999));
    await expect(call(SETTINGS, 'x', null, {})).rejects.toThrow('invalid parameter');
    await expect(call(SETTINGS, 'x', null, {})).rejects.toThrow('error code 999');
  });

  it('reports HTTP and network failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(call(SETTINGS, 'x', null, {})).rejects.toThrow('NAS answered HTTP 502');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(call(SETTINGS, 'x', null, {})).rejects.toThrow(
      'cannot reach https://nas:5001 (Failed to fetch)'
    );
  });
});

describe('call timeout', () => {
  it('gives every NAS request a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(ok({}));
    await call(SETTINGS, 'x', null, {});
    expect(timeout).toHaveBeenCalledWith(TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
    timeout.mockRestore();
  });

  it('says the NAS is not reachable when the deadline passes', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(call(SETTINGS, 'x', null, {})).rejects.toThrow(
      'NAS not reachable at https://nas:5001 (no answer in 20 s): is it switched on?'
    );
  });
});

describe('login', () => {
  const sentParams = () => Object.fromEntries(fetchMock.mock.calls[0][1].body);

  it('logs in with a Download Station session', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 's1' }));
    await expect(login(SETTINGS)).resolves.toEqual({ sid: 's1', did: '' });
    expect(sentParams()).toMatchObject({
      api: 'SYNO.API.Auth',
      method: 'login',
      account: 'dl',
      passwd: 'pw',
      session: 'DownloadStation',
      format: 'sid',
    });
  });

  it('sends the OTP and asks for a device token', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 's1', did: 'dev' }));
    await expect(login(SETTINGS, '123456')).resolves.toEqual({ sid: 's1', did: 'dev' });
    expect(sentParams()).toMatchObject({ otp_code: '123456', enable_device_token: 'yes' });
  });

  it('presents a saved device token instead of a code', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 's1' }));
    await login({ ...SETTINGS, deviceId: 'dev' });
    expect(sentParams()).toMatchObject({ device_id: 'dev' });
    expect(sentParams()).not.toHaveProperty('otp_code');
  });

  it('flags 2FA errors so the settings page can prompt for a code', async () => {
    fetchMock.mockResolvedValue(fail(403));
    await expect(login(SETTINGS)).rejects.toMatchObject({ code: 403, needOtp: true });
  });

  it('refuses to run without an address or username', async () => {
    await expect(login({ ...SETTINGS, nasUrl: '' })).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('withSession', () => {
  it('reuses a cached session', async () => {
    const state = { sid: 'cached' };
    const fn = vi.fn().mockResolvedValue('done');
    await expect(withSession(state, SETTINGS, fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledWith('cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs in again once when the cached session is stale', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 'fresh' }));
    const state = { sid: 'stale' };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new DsError('invalid session', 119))
      .mockResolvedValueOnce('done');
    await expect(withSession(state, SETTINGS, fn)).resolves.toBe('done');
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['stale', 'fresh']);
    expect(state.sid).toBe('fresh');
  });

  it('does not log in again for other errors', async () => {
    const state = { sid: 'cached' };
    const fn = vi.fn().mockRejectedValue(new DsError('destination denied', 402));
    await expect(withSession(state, SETTINGS, fn)).rejects.toThrow('destination denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs in when there is no session yet', async () => {
    fetchMock.mockResolvedValue(ok({ sid: 'new' }));
    const state = { sid: null };
    await withSession(state, SETTINGS, async (sid) => sid);
    expect(state.sid).toBe('new');
  });
});

describe('magnetFromRedirects', () => {
  it('follows a redirect chain to a magnet link', () => {
    const r = new Map([
      ['http://a', 'http://b'],
      ['http://b', MAGNET],
    ]);
    expect(magnetFromRedirects('http://a', r)).toBe(MAGNET);
  });

  it('gives up on loops and dead ends', () => {
    expect(magnetFromRedirects('http://a', new Map([['http://a', 'http://a']]))).toBeNull();
    expect(magnetFromRedirects('http://a', new Map())).toBeNull();
  });
});

describe('torrentName', () => {
  const res = (cd) => new Response('', { headers: cd ? { 'content-disposition': cd } : {} });

  it('reads a Jackett header with both filename forms and an ampersand', () => {
    const cd =
      'attachment; filename="Spinor & Phase.torrent"; filename*=UTF-8\'\'Spinor%20&%20Phase.torrent';
    expect(torrentName('http://nas:9117/dl/x/', res(cd))).toBe('Spinor & Phase.torrent');
  });

  it('decodes an RFC 5987 filename*', () => {
    const cd = "attachment; filename*=UTF-8''Caf%C3%A9%20One.torrent";
    expect(torrentName('http://x/', res(cd))).toBe('Café One.torrent');
  });

  it('falls back to the Jackett file parameter, then to the path', () => {
    expect(torrentName('http://nas:9117/dl/x/?jackett_apikey=k&file=Some+Name', res())).toBe(
      'Some Name.torrent'
    );
    expect(torrentName('https://site/files/a%20b.torrent', res())).toBe('a b.torrent');
  });

  it('replaces characters that are not allowed in file names', () => {
    expect(torrentName('http://x/', res('attachment; filename="a/b:c?.torrent"'))).toBe(
      'a_b_c_.torrent'
    );
  });

  it('never returns an empty name', () => {
    expect(torrentName('http://x/', res())).toBe('download.torrent');
  });
});

describe('resolve', () => {
  it('passes magnet links through without fetching', async () => {
    await expect(resolve(MAGNET)).resolves.toEqual({ uri: MAGNET });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the contents of a .torrent file', async () => {
    fetchMock.mockResolvedValue(
      new Response('d8:announce0:e', {
        headers: { 'content-disposition': 'attachment; filename="x.torrent"' },
      })
    );
    const item = await resolve('http://site/x');
    expect(item.name).toBe('x.torrent');
    expect(item.file.type).toBe('application/x-bittorrent');
    expect(await item.file.text()).toBe('d8:announce0:e');
  });

  it('hands anything that is not a torrent to Download Station as a URL', async () => {
    fetchMock.mockResolvedValue(new Response('<html>login</html>'));
    await expect(resolve('http://site/x')).resolves.toEqual({ uri: 'http://site/x' });
  });

  it('recovers the magnet link when the fetch fails on a redirect to magnet:', async () => {
    const redirects = new Map();
    fetchMock.mockImplementation(async (url) => {
      redirects.set(url, MAGNET); // what the webRequest listener records
      throw new TypeError('Failed to fetch');
    });
    await expect(resolve('http://nas:9117/dl/x/', redirects)).resolves.toEqual({ uri: MAGNET });
  });
});

describe('createTask', () => {
  const torrent = { file: new Blob(['d4:infoe']), name: 'x.torrent' };

  it('uploads .torrent files through the DownloadStation2 API', async () => {
    fetchMock.mockResolvedValue(ok({ task_id: ['dbid_1'] }));
    await createTask({ ...SETTINGS, destination: 'Incoming' }, torrent, 's/1');
    const [url, { body }] = fetchMock.mock.calls[0];
    // The session id must be in the query string: in the body DS2 answers "invalid session".
    expect(url).toBe('https://nas:5001/webapi/entry.cgi?_sid=s%2F1');
    expect(body.has('_sid')).toBe(false);
    expect(Object.fromEntries([...body].filter(([k]) => k !== 'torrent'))).toEqual({
      api: 'SYNO.DownloadStation2.Task',
      version: '2',
      method: 'create',
      type: '"file"',
      file: '["torrent"]',
      destination: '"Incoming"',
      create_list: 'false',
    });
    // The file must be the last part.
    expect([...body.keys()].at(-1)).toBe('torrent');
    expect(body.get('torrent').name).toBe('x.torrent');
  });

  it('sends an empty JSON destination so DS2 uses the default folder', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await createTask(SETTINGS, torrent, 's1');
    expect(fetchMock.mock.calls[0][1].body.get('destination')).toBe('""');
  });

  it('adds magnet links through the legacy task API', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await createTask({ ...SETTINGS, destination: 'Incoming' }, { uri: MAGNET }, 's1');
    const [url, { body }] = fetchMock.mock.calls[0];
    expect(url).toBe('https://nas:5001/webapi/DownloadStation/task.cgi');
    expect(Object.fromEntries(body)).toEqual({
      api: 'SYNO.DownloadStation.Task',
      version: '3',
      method: 'create',
      _sid: 's1',
      uri: MAGNET,
      destination: 'Incoming',
    });
  });

  it('omits the destination for magnet links when none is set', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await createTask(SETTINGS, { uri: MAGNET }, 's1');
    expect(fetchMock.mock.calls[0][1].body.has('destination')).toBe(false);
  });
});

describe('send', () => {
  it('logs in, adds the task and describes what it did', async () => {
    fetchMock.mockResolvedValueOnce(ok({ sid: 's1' })).mockResolvedValueOnce(ok({}));
    const state = { sid: null };
    const { message } = await send(state, SETTINGS, MAGNET, new Map());
    expect(message).toMatch(/^magnet link to Download Station \(.*add task \d+\.\d s\)$/);
    expect(state.sid).toBe('s1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
