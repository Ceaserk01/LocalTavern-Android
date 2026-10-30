// Android WebView does not expose speechSynthesis. Keep the upstream System TTS
// provider intact and use the phone's real TextToSpeech engine through a port
// transferred by the native app to this exact main-frame origin.
(() => {
    'use strict';
    if (typeof window.speechSynthesis !== 'undefined') return;
    const origin = 'http://127.0.0.1:18766';
    const maxText = 131072;
    const maxQueued = 32;
    const maxQueuedText = 262144;
    let port = null;
    let session = '';
    let voices = [];
    let queue = [];
    let active = null;
    let queuedText = 0;
    let paused = false;
    let ready = false;
    let requested = false;
    let voicesRequested = false;
    let unavailable = '';
    let sequence = 0;
    let connectionTimer = null;
    let disposed = false;
    let voiceWaiters = [];

    function handlers(target, names) {
        const values = new WeakMap();
        for (const name of names) {
            Object.defineProperty(target, 'on' + name, {
                configurable: true, enumerable: true,
                get() { return values.get(this)?.[name] || null; },
                set(value) {
                    let handlers = values.get(this);
                    if (!handlers) { handlers = {}; values.set(this, handlers); }
                    if (handlers[name]) this.removeEventListener(name, handlers[name]);
                    handlers[name] = typeof value === 'function' ? value : null;
                    if (handlers[name]) this.addEventListener(name, handlers[name]);
                },
            });
        }
    }
    class Utterance extends EventTarget {
        constructor(text = '') {
            super();
            this.text = String(text);
            this.lang = '';
            this.voice = null;
            this.volume = 1;
            this.rate = 1;
            this.pitch = 1;
        }
        get [Symbol.toStringTag]() { return 'SpeechSynthesisUtterance'; }
    }
    handlers(Utterance.prototype, ['start', 'end', 'error', 'pause', 'resume', 'boundary', 'mark']);
    class SpeechEvent extends Event {
        constructor(type, init = {}) {
            super(type);
            for (const [name, value] of Object.entries({
                utterance: init.utterance, charIndex: init.charIndex || 0,
                charLength: init.charLength || 0, elapsedTime: init.elapsedTime || 0, name: init.name || '',
            })) Object.defineProperty(this, name, { value, enumerable: true });
        }
    }
    class SpeechErrorEvent extends SpeechEvent {
        constructor(type, init = {}) {
            super(type, init);
            Object.defineProperty(this, 'error', { value: init.error || 'synthesis-failed', enumerable: true });
        }
    }
    class Voice {
        constructor(value) {
            Object.assign(this, value);
            Object.freeze(this);
        }
        get [Symbol.toStringTag]() { return 'SpeechSynthesisVoice'; }
    }
    function emit(entry, type, fields = {}) {
        const init = { ...fields, utterance: entry.utterance };
        entry.utterance.dispatchEvent(type === 'error' ? new SpeechErrorEvent(type, init) : new SpeechEvent(type, init));
    }
    function post(message) {
        if (!port || !session || disposed) return false;
        try { port.postMessage(JSON.stringify({ ...message, session })); return true; }
        catch { disconnect('synthesis-unavailable'); return false; }
    }
    function disconnect(error) {
        ready = false;
        unavailable = error;
        if (port) { port.onmessage = null; port.close(); }
        port = null; session = ''; voicesRequested = false;
        clearTimeout(connectionTimer); connectionTimer = null;
        const entries = active ? [active, ...queue] : queue;
        active = null; queue = []; queuedText = 0;
        const waiters = voiceWaiters; voiceWaiters = [];
        for (const waiter of waiters) waiter.reject(new Error(error));
        for (const entry of entries) queueMicrotask(() => emit(entry, 'error', { error }));
    }
    function requestVoices() {
        if (disposed || unavailable) return;
        requested = true;
        if (!ready && !connectionTimer) connectionTimer = setTimeout(() => disconnect('synthesis-unavailable'), 15000);
        if (port && !voicesRequested) { voicesRequested = true; post({ type: 'voices' }); }
    }
    function finish(type, fields) {
        if (!active) return;
        const entry = active;
        active = null;
        queuedText -= entry.text.length;
        emit(entry, type, fields);
        queueMicrotask(drain);
    }
    function drain() {
        if (active || paused || !queue.length || disposed) return;
        if (unavailable) {
            const entries = queue; queue = []; queuedText = 0;
            for (const entry of entries) queueMicrotask(() => emit(entry, 'error', { error: unavailable }));
            return;
        }
        if (!ready || !port) {
            requestVoices();
            if (!connectionTimer) connectionTimer = setTimeout(() => disconnect('synthesis-unavailable'), 15000);
            return;
        }
        clearTimeout(connectionTimer); connectionTimer = null;
        active = queue.shift();
        post({ type: 'speak', id: active.id, text: active.text, lang: active.lang,
            voice: active.voice, volume: active.volume, rate: active.rate, pitch: active.pitch });
    }
    class Synthesis extends EventTarget {
        get pending() { return queue.length > 0 || Boolean(active && !active.started); }
        get speaking() { return Boolean(active?.started); }
        get paused() { return paused; }
        getVoices() { requestVoices(); return voices.slice(); }
        speak(utterance) {
            if (!(utterance instanceof Utterance)) throw new TypeError('Expected a SpeechSynthesisUtterance');
            const text = String(utterance.text);
            const lang = String(utterance.lang || '');
            const voice = utterance.voice == null ? '' : String(utterance.voice.voiceURI || '');
            const volume = Number(utterance.volume), rate = Number(utterance.rate), pitch = Number(utterance.pitch);
            let error = '';
            if (text.length > maxText) error = 'text-too-long';
            else if (disposed) error = 'not-allowed';
            else if (queue.length + Boolean(active) >= maxQueued || queuedText + text.length > maxQueuedText) error = 'audio-busy';
            else if (!Number.isFinite(volume) || volume < 0 || volume > 1
                || !Number.isFinite(rate) || rate < 0.1 || rate > 10
                || !Number.isFinite(pitch) || pitch < 0 || pitch > 2
                || lang.length > 128 || voice.length > 1024) error = 'invalid-argument';
            else if (unavailable) error = unavailable;
            if (error) { queueMicrotask(() => emit({ utterance }, 'error', { error })); return; }
            if (++sequence > 2147483647) { queueMicrotask(() => emit({ utterance }, 'error', { error: 'audio-busy' })); return; }
            queue.push({ utterance, text, lang, voice, volume, rate, pitch, id: sequence, started: false });
            queuedText += text.length;
            drain();
        }
        cancel() {
            const entries = active ? [active, ...queue] : queue;
            active = null; queue = []; queuedText = 0;
            if (!voiceWaiters.length) { clearTimeout(connectionTimer); connectionTimer = null; }
            post({ type: 'cancel' });
            for (const entry of entries) queueMicrotask(() => emit(entry, 'error', { error: entry.started ? 'interrupted' : 'canceled' }));
        }
        pause() { if (!paused) { paused = true; if (active) post({ type: 'pause', id: active.id }); } }
        resume() {
            if (!paused) return;
            paused = false;
            if (active) post({ type: 'resume', id: active.id });
            else drain();
        }
    }
    handlers(Synthesis.prototype, ['voiceschanged']);
    const synthesis = new Synthesis();
    Object.defineProperties(synthesis, {
        __localTavernNative: { value: true },
        __localTavernVoicesReady: { value: () => {
            if (disposed || unavailable) return Promise.reject(new Error(unavailable || 'not-allowed'));
            if (ready) return Promise.resolve();
            if (voiceWaiters.length >= maxQueued) return Promise.reject(new Error('audio-busy'));
            const promise = new Promise((resolve, reject) => voiceWaiters.push({ resolve, reject }));
            requestVoices();
            return promise;
        } },
    });
    // Do not trust a cross-origin frame that offers its own MessagePort. Native
    // postWebMessage has a null source; synthetic MessageEvents are not trusted.
    window.addEventListener('message', event => {
        if (disposed || location.origin !== origin || !event.isTrusted || event.source !== null
            || (event.origin && event.origin !== origin) || event.ports.length !== 1) return;
        let hello;
        try { hello = JSON.parse(event.data); } catch { return; }
        if (hello.type !== 'local-tavern-tts' || hello.version !== 1
            || typeof hello.session !== 'string' || !/^[a-f0-9-]{36}$/.test(hello.session)) return;
        if (port) disconnect('interrupted');
        unavailable = ''; ready = false; voicesRequested = false;
        session = hello.session; port = event.ports[0];
        port.onmessage = message => {
            let value;
            try { if (typeof message.data !== 'string' || message.data.length > 1048576) return; value = JSON.parse(message.data); } catch { return; }
            if (value.session !== session) return;
            if (value.type === 'voices') {
                if (!Array.isArray(value.voices) || value.voices.length > 4096) { disconnect('synthesis-unavailable'); return; }
                const valid = value.voices.every(v => v && typeof v.voiceURI === 'string' && v.voiceURI.length <= 1024
                    && typeof v.name === 'string' && v.name.length <= 512 && typeof v.lang === 'string' && v.lang.length <= 128
                    && typeof v.localService === 'boolean' && typeof v.default === 'boolean');
                if (!valid) { disconnect('synthesis-unavailable'); return; }
                voices = value.voices.map(v => new Voice({ voiceURI: v.voiceURI, name: v.name, lang: v.lang,
                    localService: v.localService, default: v.default }));
                ready = true; unavailable = '';
                clearTimeout(connectionTimer); connectionTimer = null;
                const waiters = voiceWaiters; voiceWaiters = [];
                for (const waiter of waiters) waiter.resolve();
                synthesis.dispatchEvent(new Event('voiceschanged'));
                drain();
            } else if (value.type === 'unavailable') disconnect('synthesis-unavailable');
            else if (value.type === 'event' && active && value.id === active.id) {
                const fields = { charIndex: Number.isInteger(value.charIndex) ? Math.min(active.text.length, Math.max(0, value.charIndex)) : 0,
                    charLength: Number.isInteger(value.charLength) ? Math.max(0, value.charLength) : 0,
                    elapsedTime: Number.isFinite(value.elapsedTime) ? Math.max(0, value.elapsedTime) : 0, name: value.name || '' };
                if (value.event === 'start') { if (!active.started) { active.started = true; emit(active, 'start', fields); } }
                else if (value.event === 'end') finish('end', fields);
                else if (value.event === 'error') finish('error', { ...fields, error: typeof value.error === 'string' ? value.error : 'synthesis-failed' });
                else if (['pause', 'resume', 'boundary', 'mark'].includes(value.event)) emit(active, value.event, fields);
            }
        };
        port.start();
        if (requested) requestVoices();
    });
    window.addEventListener('pagehide', () => {
        synthesis.cancel(); disposed = true;
        clearTimeout(connectionTimer); connectionTimer = null;
        const waiters = voiceWaiters; voiceWaiters = [];
        for (const waiter of waiters) waiter.reject(new Error('interrupted'));
        if (port) { port.onmessage = null; port.close(); } port = null; session = '';
    });
    Object.defineProperties(window, {
        speechSynthesis: { value: synthesis, configurable: true, enumerable: true },
        SpeechSynthesisUtterance: { value: Utterance, configurable: true, enumerable: true },
    });
    for (const [name, value] of Object.entries({ SpeechSynthesisVoice: Voice, SpeechSynthesisEvent: SpeechEvent,
        SpeechSynthesisErrorEvent: SpeechErrorEvent })) {
        if (typeof window[name] === 'undefined') Object.defineProperty(window, name, { value, configurable: true, enumerable: true });
    }
})();
