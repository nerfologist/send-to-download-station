import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// lib/links.js is a classic content script, not a module: evaluate it and pick the function.
const src = readFileSync(new URL('../lib/links.js', import.meta.url), 'utf8');
const { isTorrentLink, isUserClick } = new Function(
  `${src}\nreturn { isTorrentLink, isUserClick };`
)();

describe('isTorrentLink', () => {
  it.each([
    'magnet:?xt=urn:btih:abc',
    'MAGNET:?xt=urn:btih:abc',
    'https://example.org/files/ubuntu.iso.torrent',
    'http://example.org/a.TORRENT',
    'http://nas:9117/dl/internetarchive/?jackett_apikey=k&path=p&file=f',
  ])('intercepts %s', (href) => {
    expect(isTorrentLink(href)).toBe(true);
  });

  it.each([
    'https://example.org/page.html',
    'https://example.org/a.torrent.html',
    'https://example.org/dl/thing', // a /dl/ path without the Jackett API key
    'ftp://example.org/a.torrent',
    'javascript:void(0)',
    'not a url',
  ])('leaves %s alone', (href) => {
    expect(isTorrentLink(href)).toBe(false);
  });
});

describe('isUserClick', () => {
  const click = { isTrusted: true, button: 0, altKey: false, defaultPrevented: false };

  it('accepts a plain left click made by the user', () => {
    expect(isUserClick(click)).toBe(true);
  });

  it.each([
    ['a click dispatched by a page script', { isTrusted: false }],
    ['a middle click', { button: 1 }],
    ['an Alt-click', { altKey: true }],
    ['a click the page already handled', { defaultPrevented: true }],
  ])('ignores %s', (_label, change) => {
    expect(isUserClick({ ...click, ...change })).toBe(false);
  });
});
