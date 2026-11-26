(() => {
  let intercept = true;
  chrome.storage.local.get({ intercept: true }).then((s) => (intercept = s.intercept));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.intercept) intercept = changes.intercept.newValue;
  });

  let toastEl = null;
  let toastTimer = null;
  function toast({ ok, message, pending }) {
    if (window !== window.top) return; // only the top frame draws
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'max-width:420px;padding:10px 14px;border-radius:8px;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
        'word-break:break-word;';
    }
    toastEl.textContent = message;
    toastEl.style.background = pending ? '#37474f' : ok ? '#2e7d32' : '#c62828';
    (document.body || document.documentElement).appendChild(toastEl);
    clearTimeout(toastTimer);
    if (!pending) toastTimer = setTimeout(() => toastEl.remove(), ok ? 6000 : 8000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toast') toast(msg);
  });

  document.addEventListener(
    'click',
    (e) => {
      // Orphaned copy left over from before an extension reload: step aside.
      if (!chrome.runtime?.id) return;
      if (!intercept || !isUserClick(e)) return;
      const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement && n.href);
      if (!a || !isTorrentLink(a.href)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      toast({ ok: true, message: 'Sending to Download Station…', pending: true });
      chrome.runtime
        .sendMessage({ type: 'send', url: a.href })
        .then((res) => toast(res || { ok: false, message: 'No response from extension' }))
        .catch((err) =>
          toast({ ok: false, message: `Extension error: ${err.message}. Reload the page.` })
        );
    },
    true
  );
})();
