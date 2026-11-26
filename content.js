(() => {
  let intercept = true;
  chrome.storage.local.get({ intercept: true }).then((s) => (intercept = s.intercept));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.intercept) intercept = changes.intercept.newValue;
  });

  // Toasts stack in the bottom-right corner, newest at the bottom. Each send has its own
  // toast (found by id), which goes from "Sending…" to the result and then disappears.
  let stackEl = null;
  let lastId = 0;
  const toasts = new Map(); // id -> { el, timer }
  function toast(id, { ok, message, pending }) {
    if (window !== window.top) return; // only the top frame draws
    if (!stackEl) {
      stackEl = document.createElement('div');
      stackEl.style.cssText =
        'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'display:flex;flex-direction:column;align-items:flex-end;gap:8px;' +
        'max-width:420px;pointer-events:none;';
    }
    let t = toasts.get(id);
    if (!t) {
      t = { el: document.createElement('div'), timer: null };
      t.el.style.cssText =
        'all:initial;padding:10px 14px;border-radius:8px;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
        'word-break:break-word;';
      toasts.set(id, t);
      stackEl.appendChild(t.el);
    }
    t.el.textContent = message;
    t.el.style.background = pending ? '#37474f' : ok ? '#2e7d32' : '#c62828';
    if (!stackEl.isConnected) (document.body || document.documentElement).appendChild(stackEl);
    clearTimeout(t.timer);
    if (pending) return;
    t.timer = setTimeout(
      () => {
        t.el.remove();
        toasts.delete(id);
        if (!toasts.size) stackEl.remove();
      },
      ok ? 6000 : 8000
    );
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toast') toast(`menu-${msg.id}`, msg);
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
      const id = `click-${++lastId}`;
      toast(id, { ok: true, message: 'Sending to Download Station…', pending: true });
      chrome.runtime
        .sendMessage({ type: 'send', url: a.href })
        .then((res) => toast(id, res || { ok: false, message: 'No response from extension' }))
        .catch((err) =>
          toast(id, { ok: false, message: `Extension error: ${err.message}. Reload the page.` })
        );
    },
    true
  );
})();
