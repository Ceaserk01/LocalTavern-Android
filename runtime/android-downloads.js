// Loaded before upstream modules. A download may revoke its object URL immediately
// after clicking an anchor, while Android's save picker remains open for minutes.
// Retain the Blob, without extending the lifetime of the original object URL.
(() => {
    'use strict';
    const objects = new Map();
    const downloads = new Map();
    const clicking = new WeakSet();
    const maxBytes = 2 * 1024 * 1024 * 1024;
    const maxPending = 4;
    let bytes = 0;
    let serial = 0;
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    const originalClick = HTMLAnchorElement.prototype.click;
    const originalOpen = window.open;

    function release(id) {
        const entry = downloads.get(id);
        if (entry) { bytes -= entry.blob.size; downloads.delete(id); }
    }
    function retain(url, name = '') {
        const blob = objects.get(url);
        if (!(blob instanceof Blob) || blob.size > maxBytes) return null;
        // Evict only unclaimed clicks. Never evict a file held by the save picker.
        for (const [id, entry] of downloads) {
            if (downloads.size < maxPending && bytes + blob.size <= maxBytes) break;
            if (!entry.claimed) release(id);
        }
        if (downloads.size >= maxPending || bytes + blob.size > maxBytes) return null;
        const entry = { id: String(++serial), url, name, blob, claimed: false };
        downloads.set(entry.id, entry); bytes += blob.size;
        return entry;
    }
    function pinAnchor(anchor) {
        if (anchor && anchor.href.startsWith('blob:')) retain(anchor.href, anchor.download || '');
    }
    URL.createObjectURL = function (value) {
        const url = originalCreate(value);
        if (value instanceof Blob) objects.set(url, value);
        return url;
    };
    URL.revokeObjectURL = function (url) {
        objects.delete(String(url));
        return originalRevoke(url);
    };
    HTMLAnchorElement.prototype.click = function () {
        pinAnchor(this); clicking.add(this);
        try { return originalClick.call(this); }
        finally { clicking.delete(this); }
    };
    document.addEventListener('click', event => {
        const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
        if (anchor && !clicking.has(anchor)) pinAnchor(anchor);
    }, true);
    window.open = function (url, ...args) {
        if (typeof url === 'string' && url.startsWith('blob:')) retain(url);
        return originalOpen.call(this, url, ...args);
    };
    const api = Object.freeze({
        claim(url) {
            let entry = [...downloads.values()].find(item => item.url === url && !item.claimed);
            if (!entry) entry = retain(url);
            if (!entry) return null;
            entry.claimed = true;
            return { id: entry.id, name: entry.name, blob: entry.blob };
        },
        release,
        discard(url) {
            const entry = [...downloads.values()].find(item => item.url === url && !item.claimed);
            if (entry) release(entry.id);
        },
        cancelAll() { downloads.clear(); bytes = 0; },
    });
    Object.defineProperty(window, '__LOCAL_TAVERN_DOWNLOADS__', { value: api });
    window.addEventListener('pagehide', () => { api.cancelAll(); objects.clear(); });
})();
