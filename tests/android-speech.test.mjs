import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { patchUpstream } from '../runtime/patch-upstream.mjs';

const hook = await fs.readFile(new URL('../runtime/android-speech.js', import.meta.url), 'utf8');
const upstream = new URL('../upstream/SillyTavern/', import.meta.url);
const session = '12345678-1234-1234-1234-123456789abc';
const voice = { voiceURI: 'android:test.engine:zh-CN-local', name: 'zh-CN-local', lang: 'zh-CN', localService: true, default: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(existing) {
    const listeners = new Map();
    const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
    const context = { Event, EventTarget, console: quiet, setTimeout, clearTimeout, queueMicrotask,
        navigator: { language: 'zh-CN' }, location: { origin: 'http://127.0.0.1:18766' },
        addEventListener(name, callback) { listeners.set(name, callback); } };
    context.window = context;
    if (existing) context.speechSynthesis = existing;
    vm.createContext(context);
    vm.runInContext(hook, context);
    class Port {
        messages = []; onmessage = null; closed = false; onPost = null;
        postMessage(data) {
            if (this.closed) throw new Error('Closed port');
            const message = JSON.parse(data); this.messages.push(message); this.onPost?.(message);
        }
        start() {}
        close() { this.closed = true; }
        emit(data) { this.onmessage?.({ data: JSON.stringify({ ...data, session }) }); }
    }
    const port = new Port();
    function connect(properties = {}) {
        listeners.get('message')?.({ data: JSON.stringify({ type: 'local-tavern-tts', version: 1, session }),
            isTrusted: true, source: null, origin: '', ports: [port], ...properties });
    }
    return { context, port, connect, speech: context.speechSynthesis, Utterance: context.SpeechSynthesisUtterance,
        ready() { context.speechSynthesis.getVoices(); connect(); port.emit({ type: 'voices', voices: [voice] }); },
        hide() { listeners.get('pagehide')?.(); },
        dispose() { listeners.get('pagehide')?.(); } };
}

test('existing browser speech implementation is never replaced', () => {
    const native = { getVoices: () => [] };
    const p = page(native);
    assert.equal(p.context.speechSynthesis, native);
    assert.equal(p.context.SpeechSynthesisUtterance, undefined);
    p.connect(); assert.equal(p.port.messages.length, 0);
});

test('binding the document port does not initialize an unused speech engine', t => {
    const p = page(); t.after(() => p.dispose()); p.connect();
    assert.equal(p.port.messages.length, 0);
    assert.equal(p.speech.getVoices().length, 0);
    assert.equal(p.port.messages.filter(m => m.type === 'voices').length, 1);
    p.speech.getVoices();
    assert.equal(p.port.messages.filter(m => m.type === 'voices').length, 1);
});

test('native handshake publishes actual voices and drives start/end state, without simulated completion', async t => {
    const p = page(); t.after(() => p.dispose());
    const utterance = new p.Utterance('你好 Android 🙂');
    const events = [];
    utterance.onstart = event => events.push([event.type, event.utterance === utterance, event.charIndex]);
    utterance.addEventListener('end', event => events.push([event.type, event.charIndex]));
    let changed = 0; p.speech.onvoiceschanged = () => changed++;
    p.speech.speak(utterance);
    assert.equal(p.speech.pending, true); assert.equal(p.speech.speaking, false);
    assert.equal(p.speech.getVoices().length, 0); assert.equal(p.port.messages.length, 0);
    p.ready();
    assert.equal(changed, 1);
    const voices = p.speech.getVoices();
    assert.equal(voices[0].voiceURI, voice.voiceURI);
    assert.equal(voices[0].localService, true);
    assert.ok(Object.isFrozen(voices[0]));
    voices.length = 0; assert.equal(p.speech.getVoices().length, 1);
    const command = p.port.messages.find(m => m.type === 'speak');
    assert.equal(command.text, utterance.text);
    assert.equal(events.length, 0, 'Native start/end are not fabricated by a timeout');
    p.port.emit({ type: 'event', id: command.id, event: 'start', charIndex: 0 });
    assert.equal(p.speech.speaking, true); assert.equal(p.speech.pending, false);
    p.port.emit({ type: 'event', id: command.id, event: 'end', charIndex: utterance.text.length, elapsedTime: 1.2 });
    assert.equal(p.speech.speaking, false);
    assert.deepEqual(events, [['start', true, 0], ['end', utterance.text.length]]);
    assert.equal(Object.hasOwn(utterance, 'onstart'), false, 'Event handlers use Web IDL prototype semantics');
});

test('cancel releases queued text and ignores stale completion before a new utterance', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const first = new p.Utterance('first'), second = new p.Utterance('second'), next = new p.Utterance('next');
    const errors = [], ended = [];
    for (const u of [first, second, next]) {
        u.onerror = event => errors.push([u.text, event.error]);
        u.onend = () => ended.push(u.text);
    }
    p.speech.speak(first); p.speech.speak(second);
    const id = p.port.messages.find(m => m.type === 'speak').id;
    p.port.emit({ type: 'event', id, event: 'start' });
    p.speech.cancel();
    assert.equal(p.speech.pending, false); assert.equal(p.speech.speaking, false);
    p.speech.speak(next);
    const nextId = p.port.messages.filter(m => m.type === 'speak').at(-1).id;
    assert.notEqual(nextId, id);
    p.port.emit({ type: 'event', id, event: 'end', charIndex: 5 });
    assert.equal(ended.length, 0);
    p.port.emit({ type: 'event', id: nextId, event: 'start' });
    p.port.emit({ type: 'event', id: nextId, event: 'end', charIndex: 4 });
    await tick();
    assert.deepEqual(errors, [['first', 'interrupted'], ['second', 'canceled']]);
    assert.deepEqual(ended, ['next']);
    assert.equal(p.port.messages.filter(m => m.type === 'cancel').length, 1);
});

test('pause/resume preserves queue order and exposes native boundary positions', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const first = new p.Utterance('word one word two'), second = new p.Utterance('last');
    const events = [];
    for (const name of ['boundary', 'pause', 'resume']) first.addEventListener(name, e => events.push([e.type, e.charIndex]));
    p.speech.pause(); p.speech.speak(first);
    assert.equal(p.speech.paused, true); assert.equal(p.port.messages.filter(m => m.type === 'speak').length, 0);
    p.speech.resume();
    const id = p.port.messages.find(m => m.type === 'speak').id;
    p.port.emit({ type: 'event', id, event: 'start' }); p.speech.speak(second);
    p.port.emit({ type: 'event', id, event: 'boundary', charIndex: 5, charLength: 3, name: 'word' });
    p.speech.pause();
    p.port.emit({ type: 'event', id, event: 'pause', charIndex: 5 });
    assert.equal(p.speech.paused, true); assert.equal(p.speech.speaking, true);
    p.speech.resume(); p.port.emit({ type: 'event', id, event: 'resume', charIndex: 5 });
    p.port.emit({ type: 'event', id, event: 'end', charIndex: first.text.length });
    await tick();
    assert.equal(p.port.messages.filter(m => m.type === 'speak').at(-1).text, 'last');
    assert.deepEqual(events, [['boundary', 5], ['pause', 5], ['resume', 5]]);
});

test('cross-frame/synthetic handshakes, invalid messages, and stale session events cannot control synthesis', async t => {
    const p = page(); t.after(() => p.dispose());
    p.connect({ isTrusted: false }); p.connect({ source: {} }); p.connect({ origin: 'https://example.com' });
    assert.equal(p.port.messages.length, 0);
    p.ready();
    const u = new p.Utterance('trusted'); let ended = 0;
    u.onend = () => ended++; p.speech.speak(u);
    const id = p.port.messages.find(m => m.type === 'speak').id;
    p.port.onmessage({ data: JSON.stringify({ session: 'other-session', type: 'event', id, event: 'end' }) });
    p.port.onmessage({ data: '{not json' });
    p.port.onmessage({ data: JSON.stringify({ session, type: 'event', id: id + 1, event: 'end' }) });
    assert.equal(ended, 0); assert.equal(p.speech.pending, true);
    p.port.emit({ type: 'event', id, event: 'end', charIndex: 7 });
    assert.equal(ended, 1);
});

test('input and queue limits produce truthful errors, and pagehide closes the native channel', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const errors = [];
    const speak = (text, extra = {}) => {
        const u = Object.assign(new p.Utterance(text), extra);
        u.onerror = event => errors.push(event.error); p.speech.speak(u); return u;
    };
    assert.throws(() => p.speech.speak({ text: 'not an utterance' }), { name: 'TypeError' });
    speak('x'.repeat(131073)); speak('bad rate', { rate: Infinity }); speak('bad volume', { volume: -1 });
    for (let i = 0; i < 9; i++) speak('x'.repeat(32768));
    await tick();
    assert.deepEqual(errors, ['text-too-long', 'invalid-argument', 'invalid-argument', 'audio-busy']);
    const activeId = p.port.messages.find(m => m.type === 'speak').id;
    const stale = p.port.onmessage;
    p.hide();
    assert.equal(p.port.closed, true); assert.equal(p.speech.pending, false);
    stale({ data: JSON.stringify({ session, type: 'event', id: activeId, event: 'end' }) });
    speak('after navigation'); await tick();
    assert.equal(errors.at(-1), 'not-allowed');
});

test('unavailable native engine rejects queued and subsequent utterances without fake voices or audio', async t => {
    const p = page(); t.after(() => p.dispose()); p.connect();
    let failure;
    const u = new p.Utterance('needs a real engine'); u.onerror = event => { failure = event.error; };
    p.speech.speak(u); p.port.emit({ type: 'unavailable' });
    await tick();
    assert.equal(failure, 'synthesis-unavailable'); assert.equal(p.speech.getVoices().length, 0);
    assert.equal(p.speech.speaking, false); assert.equal(p.port.messages.filter(m => m.type === 'speak').length, 0);
});

let providerSource;
async function actualProviderSource() {
    if (providerSource) return providerSource;
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tavern-tts-'));
    try {
        await fs.mkdir(path.join(stage, 'src/git'), { recursive: true });
        for (const name of ['src/endpoints/extensions.js', 'src/plugin-loader.js', 'plugins.js', 'public/scripts/extensions/tts/system.js', 'public/script.js']) {
            await fs.mkdir(path.dirname(path.join(stage, name)), { recursive: true });
            await fs.copyFile(new URL(name, upstream), path.join(stage, name));
        }
        const patches = await patchUpstream(stage);
        assert.ok(patches.changes.some(change => change.file === 'public/scripts/extensions/tts/system.js' && change.occurrences === 1));
        providerSource = (await fs.readFile(path.join(stage, 'public/scripts/extensions/tts/system.js'), 'utf8'))
            .replace(/^import .*;$/gm, '').replace(/^export \{ SystemTtsProvider \};$/m, '');
        return providerSource;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
async function provider(p) {
    p.context.t = strings => strings.join('');
    p.context.isMobile = () => false;
    p.context.getPreviewString = () => '真实系统语音预览';
    const silence = new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
    p.context.fetch = async url => { assert.equal(url, '/sounds/silence.mp3'); return silence; };
    vm.runInContext(await actualProviderSource(), p.context);
    const instance = vm.runInContext('new SystemTtsProvider()', p.context);
    instance.settings = { rate: 1.25, pitch: 0.8 };
    return { instance, silence };
}

test('exact patched upstream System provider lists real voices and previews with rate/pitch', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const { instance } = await provider(p);
    const objects = await instance.fetchTtsVoiceObjects();
    assert.equal(objects[0].voice_id, voice.voiceURI); assert.equal(objects[0].name, voice.name);
    assert.equal((await instance.getVoice(voice.name)).voice_id, voice.voiceURI);
    instance.previewTtsVoice(voice.voiceURI);
    const command = p.port.messages.filter(m => m.type === 'speak').at(-1);
    assert.equal(command.voice, voice.voiceURI); assert.equal(command.rate, 1.25); assert.equal(command.pitch, 0.8);
    assert.equal(command.text, '真实系统语音预览');
});

test('exact patched upstream provider waits for lazy native voices instead of inventing its default option', async t => {
    const p = page(); t.after(() => p.dispose()); p.connect();
    const { instance } = await provider(p);
    const objects = instance.fetchTtsVoiceObjects();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(p.port.messages.filter(m => m.type === 'voices').length, 1);
    p.port.emit({ type: 'voices', voices: [voice] });
    assert.equal((await objects)[0].voice_id, voice.voiceURI);
});

test('exact patched upstream System provider retains complete long Chinese text and native completion/error', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const { instance, silence } = await provider(p);
    const text = '连续中文没有空格以及表情🙂'.repeat(420);
    assert.ok(text.length > 4000);
    let resolved = false;
    const generated = instance.generateTts(text, voice.voiceURI).then(value => { resolved = true; return value; });
    await tick();
    const command = p.port.messages.filter(m => m.type === 'speak').at(-1);
    assert.equal(command.text, text); assert.equal(p.port.messages.filter(m => m.type === 'speak').length, 1);
    p.port.emit({ type: 'event', id: command.id, event: 'start' });
    await tick(); assert.equal(resolved, false);
    p.port.emit({ type: 'event', id: command.id, event: 'end', charIndex: text.length, elapsedTime: 7 });
    assert.equal(await generated, silence);
    const rejected = instance.generateTts('引擎错误必须拒绝', voice.voiceURI);
    await tick();
    const next = p.port.messages.filter(m => m.type === 'speak').at(-1);
    p.port.emit({ type: 'event', id: next.id, event: 'error', error: 'network' });
    await rejected.then(() => assert.fail('Native speech failure must reject the upstream promise'), () => {});
});

test('patched upstream provider keeps the original chunker for browser speech implementations', async t => {
    const p = page(); t.after(() => p.dispose()); p.ready();
    const original = p.speech;
    Object.defineProperty(p.context, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => original.getVoices(), speak: u => original.speak(u), cancel: () => original.cancel(),
    } });
    p.port.onPost = command => {
        if (command.type !== 'speak') return;
        setTimeout(() => {
            p.port.emit({ type: 'event', id: command.id, event: 'start' });
            p.port.emit({ type: 'event', id: command.id, event: 'end', charIndex: command.text.length });
        }, 0);
    };
    const { instance } = await provider(p);
    const text = '你好 Android browser synthesis. '.repeat(20).trim() + ' End.';
    await instance.generateTts(text, voice.voiceURI);
    const commands = p.port.messages.filter(m => m.type === 'speak');
    assert.ok(commands.length > 1);
    assert.equal(commands.map(m => m.text).join(''), text);
});
