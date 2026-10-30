// Native clipboard reads are available only after the local app transfers its
// document-scoped port. Every read still needs a separate Android consent dialog.
// Leave Chromium's working writeText and ordinary browser behavior untouched.
(() => {
    'use strict';
    const origin = 'http://127.0.0.1:18766';
    const maxText = 524288; // One MiB of UTF-16 text.
    if (location.origin !== origin || window.top !== window || !navigator.clipboard) return;
    const clipboard = navigator.clipboard;
    let port = null;
    let session = '';
    let pending = null;
    let sequence = 0;
    let original = null;
    let originalDescriptor;
    let installed = false;
    let disposed = false;

    function denied(message = 'Clipboard read was not allowed') { return new DOMException(message, 'NotAllowedError'); }
    function settle(error, text = '') {
        const request = pending;
        if (!request) return;
        pending = null;
        clearTimeout(request.timer);
        if (error) request.reject(error);
        else request.resolve(text);
    }
    function send(message) {
        if (!port || disposed) return false;
        try { port.postMessage(JSON.stringify({ ...message, session })); return true; }
        catch { disconnect(); return false; }
    }
    function cancel() {
        if (!pending) return;
        send({ type: 'cancel', id: pending.id });
        settle(denied());
    }
    function restore() {
        if (!installed) return;
        if (clipboard.readText === readText) {
            if (originalDescriptor) Object.defineProperty(clipboard, 'readText', originalDescriptor);
            else delete clipboard.readText;
        }
        installed = false;
    }
    function disconnect() {
        settle(denied());
        if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
        port = null; session = '';
        restore();
    }
    function readText() {
        if (disposed || document.visibilityState !== 'visible' || !document.hasFocus()
            || navigator.userActivation?.isActive !== true) return Promise.reject(denied());
        if (pending) return Promise.reject(denied('A clipboard read is already pending'));
        if (!port) {
            try { return original ? Promise.resolve(original.call(clipboard)) : Promise.reject(denied()); }
            catch (error) { return Promise.reject(error); }
        }
        if (++sequence > 2147483647) return Promise.reject(denied());
        return new Promise((resolve, reject) => {
            const id = sequence;
            const timer = setTimeout(() => {
                if (pending?.id !== id) return;
                send({ type: 'cancel', id });
                settle(denied('Clipboard read timed out'));
            }, 65000);
            pending = { id, timer, resolve, reject };
            if (!send({ type: 'read', id })) settle(denied());
        });
    }
    window.addEventListener('message', event => {
        if (disposed || !event.isTrusted || event.source !== null || (event.origin && event.origin !== origin)
            || event.ports.length !== 1) return;
        let hello;
        try { hello = JSON.parse(event.data); } catch { return; }
        if (hello.type !== 'local-tavern-clipboard' || hello.version !== 1 || typeof hello.session !== 'string'
            || !/^[a-f0-9-]{36}$/.test(hello.session)) return;
        if (port) disconnect();
        if (!installed) {
            original = typeof clipboard.readText === 'function' ? clipboard.readText : null;
            originalDescriptor = Object.getOwnPropertyDescriptor(clipboard, 'readText');
            try { Object.defineProperty(clipboard, 'readText', { value: readText, configurable: true, writable: true }); }
            catch { event.ports[0].close(); return; }
            installed = true;
        }
        session = hello.session;
        port = event.ports[0];
        const boundPort = port, boundSession = session;
        port.onmessage = message => {
            if (port !== boundPort || session !== boundSession) return;
            let value;
            try {
                if (typeof message.data !== 'string') return;
                if (message.data.length > maxText * 6 + 1024) {
                    settle(new DOMException('Clipboard text exceeds the supported size', 'DataError')); return;
                }
                value = JSON.parse(message.data);
            } catch { return; }
            if (value.session !== session || value.type !== 'result' || !pending || value.id !== pending.id) return;
            if (value.ok === true) {
                if (typeof value.text !== 'string' || value.text.length > maxText) {
                    settle(new DOMException('Clipboard text exceeds the supported size', 'DataError'));
                } else settle(null, value.text);
            } else {
                const name = value.error === 'DataError' ? 'DataError' : 'NotAllowedError';
                settle(new DOMException(name === 'DataError' ? 'Clipboard text exceeds the supported size' : 'Clipboard read was not allowed', name));
            }
        };
        port.onmessageerror = () => { if (port === boundPort) disconnect(); };
        port.start();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') cancel(); });
    window.addEventListener('pagehide', () => {
        cancel(); disposed = true; disconnect();
    });
})();
