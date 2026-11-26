// Which links the extension intercepts. A classic script (content scripts cannot import
// modules): the manifest loads it before content.js, which calls isTorrentLink.
// eslint-disable-next-line no-unused-vars
function isTorrentLink(href) {
  if (/^magnet:/i.test(href)) return true;
  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (/\.torrent$/i.test(u.pathname)) return true;
  // Jackett download links: /dl/<indexer>/?jackett_apikey=...&path=...&file=...
  return u.pathname.includes('/dl/') && u.searchParams.has('jackett_apikey');
}
