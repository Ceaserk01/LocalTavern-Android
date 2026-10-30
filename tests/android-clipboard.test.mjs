import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../runtime/android-clipboard.js', import.meta.url), 'utf8');
const slashSource = await fs.readFile(new URL('../upstream/SillyTavern/public/scripts/slash-commands.js', import.meta.url), 'utf8');
const settingsSource = await fs.readFile(new URL('../upstream/SillyTavern/public/scripts/extensions/quick-reply/src/ui/SettingsUi.js', import.meta.url), 'utf8');
const clipboardBlock = slashSource.slice(slashSource.indexOf("name: 'clipboard-get',"));
const callbackStart = clipboardBlock.indexOf('callback: ') + 'callback: '.length;
const clipboardCallback = clipboardBlock.slice(callbackStart, clipboardBlock.indexOf(',\n        helpString:', callbackStart));
const qrStart = settingsSource.indexOf("this.dom.querySelector('#qr--set-paste').addEventListener('click', async () => {");
const qrBodyStart = settingsSource.indexOf("async () => {", qrStart) + 'async () => '.length;
const qrBody = settingsSource.slice(qrBodyStart, settingsSource.indexOf('\n        });', qrBodyStart) + '\n        }'.length);
const origin = 'http://127.0.0.1:18766';
const session = '12345678-1234-1234-1234-123456789abc';
const laterSession = '87654321-4321-4321-4321-cba987654321';
const maxText = 524288;
const tick = () => new Promise(resolve => setImmediate(resolve));

function page({ actualOrigin = origin, mainFrame = true, hasClipboard = true } = {}) {
    const windowListeners = new Map(), documentListeners = new Map(), timers = new Map();
    let nextTimer = 0;
    const calls = { nativeRead: 0, write: [], warnings: [] };
    const originalRead = async () => { calls.nativeRead++; return 'original browser result'; };
    const originalWrite = async text => { calls.write.push(text); };
    const clipboard = { readText: originalRead, writeText: originalWrite };
    const document = { visibilityState: 'visible', focused: true, hasFocus() { return this.focused; },
        addEventListener(name, callback) { documentListeners.set(name, callback); } };
    const context = { document, DOMException, navigator: { userActivation: { isActive: true }, ...(hasClipboard ? { clipboard } : {}) },
        location: { origin: actualOrigin }, console: { error() {} }, toastr: { warning: text => calls.warnings.push(text) },
        t: strings => strings.join(''), Promise,
        addEventListener(name, callback) { windowListeners.set(name, callback); },
        setTimeout(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
        clearTimeout(id) { timers.delete(id); } };
    context.window = context; context.top = mainFrame ? context : {};
    vm.createContext(context); vm.runInContext(source, context);
    class Port {
        messages = []; closed = false; onmessage = null; onmessageerror = null;
        postMessage(data) { if (this.closed) throw new Error('Closed port'); this.messages.push(JSON.parse(data)); }
        close() { this.closed = true; }
        start() {}
        reply(value, currentSession = session) { this.onmessage?.({ data: JSON.stringify({ type: 'result', session: currentSession, ...value }) }); }
    }
    function connect(properties = {}, currentSession = session) {
        const port = new Port();
        windowListeners.get('message')?.({ data: JSON.stringify({ type: 'local-tavern-clipboard', version: 1, session: currentSession }),
            isTrusted: true, source: null, origin: '', ports: [port], ...properties });
        return port;
    }
    return { context, clipboard, document, calls, connect, originalRead, originalWrite, timers,
        hide() { document.visibilityState = 'hidden'; documentListeners.get('visibilitychange')?.(); },
        close() { windowListeners.get('pagehide')?.(); },
        expire() { const callbacks = [...timers.values()]; timers.clear(); for (const timer of callbacks) timer.callback(); } };
}

test('normal browsers and frames keep original clipboard methods until an exact native main-frame handshake', async t => {
    const p = page(); t.after(() => p.close());
    assert.equal(p.clipboard.readText, p.originalRead);
    assert.equal(await p.clipboard.readText(), 'original browser result');
    const wrongOrigin = page({ actualOrigin: 'https://example.com' }); wrongOrigin.connect();
    assert.equal(wrongOrigin.clipboard.readText, wrongOrigin.originalRead);
    const frame = page({ mainFrame: false }); frame.connect();
    assert.equal(frame.clipboard.readText, frame.originalRead);
    page({ hasClipboard: false }).connect();
    p.connect({ isTrusted: false }); p.connect({ source: {} }); p.connect({ origin: 'https://example.com' });
    assert.equal(p.clipboard.readText, p.originalRead);
    const port = p.connect();
    assert.notEqual(p.clipboard.readText, p.originalRead);
    assert.equal(p.clipboard.writeText, p.originalWrite);
    assert.equal(port.messages.length, 0, 'Binding a document must not read the clipboard');
    await p.clipboard.writeText('copy still works');
    assert.deepEqual(p.calls.write, ['copy still works']);
});

test('native reads remain pending for a consent result, return exact text once, and never call the denied browser API', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    let resolved = false;
    const result = p.clipboard.readText().then(value => { resolved = true; return value; });
    assert.equal(port.messages.length, 1);
    assert.equal(port.messages[0].type, 'read');
    await tick(); assert.equal(resolved, false);
    const text = '角色卡 JSON\n中文🙂\u0000保留全部内容';
    port.reply({ id: port.messages[0].id, ok: true, text });
    assert.equal(await result, text);
    assert.equal(p.calls.nativeRead, 0); assert.equal(p.timers.size, 0);
    port.reply({ id: port.messages[0].id, ok: true, text: 'late duplicate' });
    assert.equal(await result, text);
});

test('visible focus and transient user activation are required before prompting; one request is pending at a time', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    for (const state of ['hidden', 'unfocused', 'inactive']) {
        p.document.visibilityState = state === 'hidden' ? 'hidden' : 'visible';
        p.document.focused = state !== 'unfocused';
        p.context.navigator.userActivation.isActive = state !== 'inactive';
        await assert.rejects(p.clipboard.readText(), { name: 'NotAllowedError' });
    }
    assert.equal(port.messages.length, 0);
    p.document.focused = true; p.document.visibilityState = 'visible'; p.context.navigator.userActivation.isActive = true;
    const first = p.clipboard.readText();
    await assert.rejects(p.clipboard.readText(), { name: 'NotAllowedError' });
    assert.equal(port.messages.filter(m => m.type === 'read').length, 1);
    port.reply({ id: port.messages[0].id, ok: false, error: 'NotAllowedError' });
    await assert.rejects(first, { name: 'NotAllowedError' });
    const second = p.clipboard.readText();
    port.reply({ id: port.messages.at(-1).id, ok: true, text: '' });
    assert.equal(await second, '', 'URI-only or absent plain text can be empty after consent');
});

test('denial, backgrounding, page closure and deadlines reject without retaining old clipboard results', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    const canceled = p.clipboard.readText();
    port.reply({ id: port.messages.at(-1).id, ok: false, error: 'NotAllowedError' });
    await assert.rejects(canceled, { name: 'NotAllowedError' });
    const background = p.clipboard.readText(); const backgroundId = port.messages.at(-1).id;
    p.hide(); await assert.rejects(background, { name: 'NotAllowedError' });
    assert.equal(port.messages.at(-1).type, 'cancel');
    port.reply({ id: backgroundId, ok: true, text: 'must not leak after background' });
    p.document.visibilityState = 'visible';
    const expired = p.clipboard.readText();
    assert.equal([...p.timers.values()][0].milliseconds, 65000);
    p.expire(); await assert.rejects(expired, { name: 'NotAllowedError' });
    const captured = p.clipboard.readText;
    const closed = p.clipboard.readText();
    p.close(); await assert.rejects(closed, { name: 'NotAllowedError' });
    assert.equal(port.closed, true); assert.equal(p.clipboard.readText, p.originalRead); assert.equal(p.timers.size, 0);
    await assert.rejects(captured(), { name: 'NotAllowedError' });
});

test('old sessions, replies, and channel errors cannot settle a replacement document port', async t => {
    const p = page(); t.after(() => p.close());
    const firstPort = p.connect();
    const oldMessage = firstPort.onmessage, oldError = firstPort.onmessageerror;
    const first = p.clipboard.readText();
    const oldId = firstPort.messages[0].id;
    const secondPort = p.connect({}, laterSession);
    await assert.rejects(first, { name: 'NotAllowedError' });
    const second = p.clipboard.readText();
    const id = secondPort.messages[0].id;
    oldMessage({ data: JSON.stringify({ type: 'result', session, id: oldId, ok: true, text: 'old' }) });
    oldError();
    secondPort.reply({ id, ok: true, text: 'wrong session' });
    secondPort.reply({ id: id + 1, ok: true, text: 'wrong id' }, laterSession);
    assert.equal(secondPort.closed, false);
    secondPort.reply({ id, ok: true, text: 'current result' }, laterSession);
    assert.equal(await second, 'current result');
});

test('size limits reject oversized text and malformed native payloads rather than returning false empty success', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    const full = p.clipboard.readText();
    port.reply({ id: port.messages.at(-1).id, ok: true, text: 'x'.repeat(maxText) });
    assert.equal((await full).length, maxText);
    for (const payload of [{ text: 'x'.repeat(maxText + 1) }, { text: null }]) {
        const read = p.clipboard.readText();
        port.reply({ id: port.messages.at(-1).id, ok: true, ...payload });
        await assert.rejects(read, { name: 'DataError' });
    }
    const nativeLimit = p.clipboard.readText();
    port.reply({ id: port.messages.at(-1).id, ok: false, error: 'DataError' });
    await assert.rejects(nativeLimit, { name: 'DataError' });
    const packetLimit = p.clipboard.readText();
    port.onmessage({ data: 'x'.repeat(maxText * 6 + 1025) });
    await assert.rejects(packetLimit, { name: 'DataError' });
});

test('exact upstream clipboard-get returns text only after native consent and preserves its rejection behavior', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    const callback = vm.runInContext('(' + clipboardCallback + ')', p.context);
    const command = callback();
    assert.equal(port.messages[0].type, 'read');
    port.reply({ id: port.messages[0].id, ok: true, text: '真实剪贴板指令输入' });
    assert.equal(await command, '真实剪贴板指令输入');
    const denied = callback();
    port.reply({ id: port.messages.at(-1).id, ok: false, error: 'NotAllowedError' });
    assert.equal(await denied, '');
    assert.equal(p.calls.warnings.length, 1);
});

test('exact upstream Quick Reply paste callback receives the consented text unchanged', async t => {
    const p = page(); t.after(() => p.close()); const port = p.connect();
    const paste = vm.runInContext('(async function() ' + qrBody + ')', p.context);
    const imported = [];
    const action = paste.call({ currentQrSet: { addQuickReplyFromText: text => imported.push(text) } });
    assert.equal(imported.length, 0);
    const text = '{"label":"角色回复","message":"你好🙂"}';
    port.reply({ id: port.messages[0].id, ok: true, text });
    await action;
    assert.deepEqual(imported, [text]);
    assert.equal(p.calls.nativeRead, 0);
});
