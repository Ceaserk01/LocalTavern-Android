// UI instrumentation for this app's disposable Android emulator only. No model API.
// TAVERN_UI_TEST_DISPOSABLE=1 TAVERN_BENCH_ADB_SERIAL=emulator-5554 \
//   node scripts/benchmark_webview.mjs
// Optional: TAVERN_BENCH_ADB_PATH, TAVERN_UI_REPORT_PATH (must not exist).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.env.TAVERN_BENCH_ADB_SERIAL;
const adb = process.env.TAVERN_BENCH_ADB_PATH || path.join(project, '.tooling/android/platform-tools/adb');
const packageName = 'app.local.tavern';
const origin = 'http://127.0.0.1:18766';
const fixture = `ltui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const avatar = `${fixture}.png`;
const qaKey = `__${fixture}`;
const forwards = [];
const cookies = new Map();
const priorAvatars = new Set();
const priorBackups = new Set();
const importedChats = [];
const report = {
    schemaVersion: 1, fixture, completed: false, startedAt: new Date().toISOString(),
    scope: 'Actual own-app Android WebView via its PID-bound developer socket; upstream chat open/render/edit paths. Two rAF callbacks indicate drawing opportunities, not screen presentation. Synthetic input is not IME or trusted input latency. No physical-phone or GPU FPS claim.',
    driver: { node: process.version, platform: process.platform, arch: process.arch },
    workload: { messageCounts: [500, 5000], repeatsAfterFirstOpen: 3, olderMessageBatch: 100 },
    measurements: {}, cleanup: { pageRestored: false, characterDeleted: false, backupsDeleted: 0, forwardsRemoved: 0, errors: [] },
};
let base, csrf, socket, nextId = 0, pageStateCaptured = false, fixtureCreated = false, fixtureImportAttempted = false, interrupted = false;
let reportPath, profiling = false;
const pending = new Map();
const signalHandler = () => { interrupted = true; };
process.on('SIGINT', signalHandler);
process.on('SIGTERM', signalHandler);

function round(value) { return Math.round(value * 100) / 100; }
function summary(values) {
    if (!values.length) return { samples: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const q = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    return { samples: values.length, minMs: round(sorted[0]), p50Ms: round(q(0.5)), p95Ms: round(q(0.95)), maxMs: round(sorted.at(-1)) };
}
function checkInterrupted() { assert.ok(!interrupted, 'Benchmark interrupted; performing fixture cleanup'); }
function adbCall(args) {
    return execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function shell(...args) { return adbCall(['shell', ...args]); }
function mappings() {
    return adbCall(['forward', '--list']).split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
}
async function forward(remote) {
    const reserve = http.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const local = `tcp:${port}`;
    assert.ok(!mappings().some(parts => parts[1] === local), 'Refusing to replace an existing ADB forward');
    adbCall(['forward', '--no-rebind', local, remote]);
    const owned = { serial, local, remote };
    forwards.push(owned);
    return port;
}
function removeForwards() {
    for (const owned of [...forwards].reverse()) {
        try {
            const current = mappings().find(parts => parts[0] === owned.serial && parts[1] === owned.local);
            if (!current) report.cleanup.forwardsRemoved++;
            else if (current[2] === owned.remote) {
                adbCall(['forward', '--remove', owned.local]); report.cleanup.forwardsRemoved++;
            } else report.cleanup.errors.push(`Owned ADB forward changed; left untouched: ${owned.local}`);
        } catch { report.cleanup.errors.push(`Could not remove owned ADB forward: ${owned.local}`); }
    }
}
async function api(endpoint, body) {
    const form = body instanceof FormData;
    const response = await fetch(`${base}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined || form ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], split = pair.indexOf('=');
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    // Do not include arbitrary server response bodies, cookies or credentials in diagnostics.
    assert.ok(response.ok, `${endpoint}: HTTP ${response.status}`);
    const text = await response.text();
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function command(method, params = {}, timeoutMs = 60000) {
    assert.ok(socket?.readyState === WebSocket.OPEN, 'Own-app WebView connection is not open');
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Own-app ${method} timed out`)); }, timeoutMs);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(fn, arg) {
    const result = await command('Runtime.evaluate', {
        expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true,
        userGesture: true, objectGroup: fixture,
    });
    if (result.exceptionDetails) {
        // The page functions below throw only fixture diagnostics, never captured settings/drafts.
        const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'UI instrumentation failed';
        throw new Error(String(message).slice(0, 600));
    }
    return result.result.value;
}
async function setupPage({ key, ownedAvatar }) {
    if (window[key]) throw new Error('Fixture instrumentation namespace already exists');
    if (document.visibilityState !== 'visible') throw new Error('Bring this Android app to the foreground before benchmarking');
    if (document.querySelector('dialog[open]')) throw new Error('Complete onboarding or dismiss the open dialog through the normal UI before benchmarking');
    const script = await import('/script.js');
    const context = SillyTavern.getContext();
    if (!context.eventSource.autoFireLastArgs.has(context.eventTypes.APP_READY) || context.loader.isBlocking()) {
        throw new Error('Wait for the normal upstream application startup to complete before benchmarking');
    }
    if (script.is_send_press || script.isChatSaving || document.body.dataset.generating === 'true' || document.querySelector('#curEditTextarea')) {
        throw new Error('Refusing to switch a page with active generation, save or message edit');
    }
    const limit = Number(context.powerUserSettings.chat_truncation);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('This bounded benchmark requires existing chat pagination from 1 to 1000; it does not change settings');
    }
    const area = document.querySelector('#send_textarea');
    if (!area) throw new Error('The upstream chat UI is not ready');
    const state = window[key] = {
        avatar: ownedAvatar, limit, script, chatSaveWrites: [],
        original: { avatar: context.characters[context.characterId]?.avatar, groupId: context.groupId,
            chatId: context.chatId, name2: context.name2, draft: area.value,
            neutralChat: context.characterId === undefined && !context.groupId ? JSON.parse(JSON.stringify(context.chat)) : null,
            metadata: context.characterId === undefined && !context.groupId ? JSON.parse(JSON.stringify(context.chatMetadata)) : null,
            limit: context.powerUserSettings.chat_truncation, fast: context.powerUserSettings.fast_ui_mode },
    };
    state.originalFetch = window.fetch;
    state.fetchWrapper = function (resource, init) {
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url && new URL(url, location.href).pathname === '/api/chats/save') {
            const current = SillyTavern.getContext();
            if (current.characters[current.characterId]?.avatar === state.avatar) state.chatSaveWrites.push(performance.now());
        }
        return state.originalFetch.call(this, resource, init);
    };
    window.fetch = state.fetchWrapper;
    state.frames = async function (count = 2) {
        for (let i = 0; i < count; i++) await new Promise((resolve, reject) => {
            let request;
            const timeout = setTimeout(() => { cancelAnimationFrame(request); reject(new Error('WebView animation frame stalled or page became hidden')); }, 5000);
            request = requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
        });
    };
    state.dom = function () {
        const messages = [...document.querySelectorAll('#chat > .mes')];
        return { count: messages.length, firstId: Number(messages[0]?.getAttribute('mesid')),
            lastId: Number(messages.at(-1)?.getAttribute('mesid')), showMore: Boolean(document.querySelector('#show_more_messages')) };
    };
    return { userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        configuredChatTruncation: limit, defaultChatTruncation: limit === 100,
        fastUiMode: context.powerUserSettings.fast_ui_mode, noBlurClass: document.body.classList.contains('no-blur'),
        streamingFps: context.powerUserSettings.streaming_fps, visibility: document.visibilityState, noOpenDialog: true,
        appReady: true, regexDepthAlgorithm: script.messageFormatting.toString().includes('const numericMessageId') ? 'tail-scan' : 'upstream-index-map',
        performanceEntriesSupported: globalThis.PerformanceObserver?.supportedEntryTypes || [] };
}
async function preparePage({ key }) {
    const q = window[key];
    await SillyTavern.getContext().getCharacters();
    q.characterId = SillyTavern.getContext().characters.findIndex(item => item.avatar === q.avatar);
    if (q.characterId < 0) throw new Error('HTTP fixture is not visible in this WebView account');
    return true;
}
async function measureOpen({ key, chatName, count, select }) {
    const q = window[key], context = SillyTavern.getContext();
    if (document.visibilityState !== 'visible') throw new Error('WebView became hidden during benchmark');
    const longTasks = [], frames = [];
    let observer, frameRequest, sampling = true, changedAt;
    const start = performance.now();
    const onChanged = () => { if (SillyTavern.getContext().chatId === chatName) changedAt ??= performance.now(); };
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, onChanged);
    const sampleFrame = stamp => { if (sampling) { frames.push(stamp); frameRequest = requestAnimationFrame(sampleFrame); } };
    frameRequest = requestAnimationFrame(sampleFrame);
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
        observer = new PerformanceObserver(list => { for (const item of list.getEntries()) longTasks.push({ startTime: item.startTime, duration: item.duration }); });
        observer.observe({ type: 'longtask' });
    }
    try {
        if (select) await context.selectCharacterById(q.characterId, { switchMenu: false });
        else await context.openCharacterChat(chatName);
        const actionAt = performance.now();
        await q.frames(2);
        const readyAt = performance.now();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (observer) for (const item of observer.takeRecords()) longTasks.push({ startTime: item.startTime, duration: item.duration });
        const state = SillyTavern.getContext(), dom = q.dom();
        if (changedAt === undefined || state.chatId !== chatName || state.chat.length !== count) throw new Error('Upstream chat open did not complete with the expected fixture');
        if (dom.count !== Math.min(q.limit, count) || dom.firstId !== Math.max(0, count - q.limit) || dom.lastId !== count - 1) {
            throw new Error('Upstream chat pagination rendered unexpected message IDs or count');
        }
        return { operation: select ? 'selectCharacterById' : 'openCharacterChat', messageCount: count,
            chatChangedMs: changedAt - start, actionCompletedMs: actionAt - start, twoFramesAfterActionMs: readyAt - start,
            dom, longTaskSupported: Boolean(observer), longTasks: longTasks.filter(item => item.startTime >= start && item.startTime < readyAt),
            actionStartToFirstFrameMs: frames.length ? frames[0] - start : null,
            frameGapsMs: frames.slice(1).map((stamp, i) => stamp - frames[i]),
            frameScope: 'rAF callback intervals in the target document during this action; not GPU FPS or display presentation' };
    } finally {
        sampling = false; cancelAnimationFrame(frameRequest); observer?.disconnect();
        context.eventSource.removeListener(context.eventTypes.CHAT_CHANGED, onChanged);
    }
}
async function measureInteractions({ key }) {
    const q = window[key], script = q.script;
    const before = q.dom();
    const start = performance.now();
    await script.showMoreMessages(100);
    await q.frames(2);
    const olderMs = performance.now() - start, after = q.dom();
    const added = Math.min(100, before.firstId);
    if (after.count !== before.count + added || after.firstId !== before.firstId - added || after.lastId !== before.lastId) {
        throw new Error('Older-message pagination lost or duplicated a fixture message');
    }
    const area = document.querySelector('#send_textarea'), dispatchMs = [], nextFrameMs = [];
    for (let i = 0; i < 10; i++) {
        const began = performance.now();
        area.value = `unsent-ui-benchmark-${i}`;
        area.dispatchEvent(new Event('input', { bubbles: true }));
        dispatchMs.push(performance.now() - began);
        await q.frames(1); nextFrameMs.push(performance.now() - began);
        if (area.value !== `unsent-ui-benchmark-${i}`) throw new Error('Synthetic unsent draft was not retained');
    }
    const context = SillyTavern.getContext(), last = context.chat.length - 1, originalText = context.chat[last].mes;
    const editStart = performance.now();
    await script.messageEdit(last);
    await q.frames(2);
    const editMs = performance.now() - editStart;
    if (document.querySelector('#curEditTextarea')?.value !== originalText.trim()) throw new Error('Upstream message editor did not show the fixture text');
    const cancel = document.querySelector(`#chat > .mes[mesid="${last}"] .mes_edit_cancel`);
    if (!cancel) throw new Error('Upstream message edit cancel control is missing');
    const cancelStart = performance.now(); cancel.click();
    for (let i = 0; i < 120 && document.querySelector('#curEditTextarea'); i++) await q.frames(1);
    await q.frames(2);
    if (document.querySelector('#curEditTextarea') || context.chat[last].mes !== originalText) throw new Error('Edit cancellation changed fixture data or did not finish');
    return { olderMessages: { batchRequested: 100, added, before, after, twoFramesAfterActionMs: olderMs },
        syntheticDraft: { samples: dispatchMs.length, dispatchMs, nextFrameMs,
            scope: 'Programmatic textarea value/input dispatch and next rAF in the same WebView; excludes OS keyboard, trusted input and visual presentation' },
        messageEdit: { openTwoFramesMs: editMs, cancelTwoFramesMs: performance.now() - cancelStart, unchanged: true } };
}
async function restorePage({ key }) {
    const q = window[key];
    if (!q) return { restored: false, reason: 'Instrumentation namespace is missing' };
    const script = q.script, original = q.original;
    const groups = await import('/scripts/group-chats.js');
    let restoredSuccessfully = false;
    try {
        document.querySelector('#chat .mes_edit_cancel')?.click();
        script.cancelDebouncedChatSave();
        const extensions = await import('/scripts/extensions.js');
        extensions.cancelDebouncedMetadataSave?.();
        if (original.groupId) {
            await groups.openGroupById(original.groupId);
            if (SillyTavern.getContext().chatId !== original.chatId) await SillyTavern.getContext().openGroupChat(original.groupId, original.chatId);
        } else if (original.avatar) {
            const context = SillyTavern.getContext();
            const id = context.characters.findIndex(item => item.avatar === original.avatar);
            if (id < 0) throw new Error('Original selected character disappeared; refusing to claim page restoration');
            await context.selectCharacterById(id, { switchMenu: false });
            if (SillyTavern.getContext().chatId !== original.chatId && original.chatId) await SillyTavern.getContext().openCharacterChat(original.chatId);
        } else {
            await script.clearChat({ clearData: true }); groups.resetSelectedGroup();
            script.resetChatState(); script.setActiveCharacter(null); script.setActiveGroup(null); script.setCharacterName(original.name2);
            script.chat.splice(0, script.chat.length, ...original.neutralChat);
            script.updateChatMetadata(original.metadata, true);
            await script.getCharacters(); await script.printMessages();
            await script.eventSource.emit(script.event_types.CHAT_CHANGED, script.getCurrentChatId());
        }
        await q.frames(2);
        const area = document.querySelector('#send_textarea');
        area.value = original.draft; area.dispatchEvent(new Event('input', { bubbles: true }));
        const now = SillyTavern.getContext();
        const restored = area.value === original.draft && now.powerUserSettings.chat_truncation === original.limit
            && now.powerUserSettings.fast_ui_mode === original.fast
            && (original.groupId ? now.groupId === original.groupId && now.chatId === original.chatId
                : original.avatar ? now.characters[now.characterId]?.avatar === original.avatar && now.chatId === original.chatId
                    : now.characterId === undefined && !now.groupId);
        restoredSuccessfully = restored;
        return { restored, settingsPreserved: now.powerUserSettings.chat_truncation === original.limit && now.powerUserSettings.fast_ui_mode === original.fast,
            ownedChatSaveWrites: q.chatSaveWrites.length,
            msSinceLastOwnedChatSave: q.chatSaveWrites.length ? performance.now() - q.chatSaveWrites.at(-1) : null };
    } finally {
        if (window.fetch === q.fetchWrapper) window.fetch = q.originalFetch;
        // Keep only the own-app restoration state available for a manual retry
        // if the page failed; never report captured drafts or settings values.
        if (restoredSuccessfully) delete window[key];
    }
}
async function cleanFixtures(pageRestore) {
    if (!base || !csrf || !fixtureImportAttempted) return;
    try {
        // Normal JSONL import does not enqueue chat backups. If an extension saved
        // a fixture while it was open, drain the configured backend throttle first.
        if (pageRestore?.ownedChatSaveWrites) {
            const section = shell("sed -n '/^backups:/,/^[^ #]/p' /data/user/0/app.local.tavern/files/userdata/config.yaml");
            const match = section.match(/^    throttleInterval:\s*(\d+)\s*(?:#.*)?$/m);
            assert.ok(match, 'Cannot establish configured backup throttle for fixture cleanup');
            const throttleMs = Number(match[1]);
            assert.ok(Number.isSafeInteger(throttleMs) && throttleMs >= 0 && throttleMs <= 60000, 'Configured backup throttle is outside this bounded cleanup range');
            const waitMs = Math.max(0, throttleMs + 1500 - pageRestore.msSinceLastOwnedChatSave);
            report.cleanup.backupThrottleDrainMs = round(waitMs);
            if (waitMs) await delay(waitMs);
        }
        const current = await api('/api/characters/all', {});
        const owned = current.find(item => item.avatar === avatar && item.name === fixture && !priorAvatars.has(item.avatar));
        if (fixtureCreated && !owned) throw new Error('Owned fixture identity changed; left untouched');
        const prefix = `chat_${fixture.toLowerCase()}_`;
        const backups = await api('/api/backups/chat/get', {});
        for (const backup of backups) {
            const name = backup.file_name;
            if (typeof name !== 'string' || priorBackups.has(name) || !name.startsWith(prefix) || !name.endsWith('.jsonl') || /[/\\]/.test(name)) continue;
            await api('/api/backups/chat/delete', { name }); report.cleanup.backupsDeleted++;
        }
        if (owned) {
            await api('/api/characters/delete', { avatar_url: avatar, delete_chats: true });
            report.cleanup.characterDeleted = true;
        }
        const remaining = await api('/api/characters/all', {});
        assert.ok(!remaining.some(item => item.avatar === avatar), 'Owned fixture character remains after deletion');
        assert.ok(!(await api('/api/backups/chat/get', {})).some(item => String(item.file_name).startsWith(prefix) && !priorBackups.has(item.file_name)), 'Owned fixture backups remain after cleanup');
        report.cleanup.noOwnedFixturesRemain = true;
    } catch (error) { report.cleanup.errors.push(error.message); }
}

try {
    assert.equal(process.env.TAVERN_UI_TEST_DISPOSABLE, '1', 'Set TAVERN_UI_TEST_DISPOSABLE=1 only for a disposable test emulator');
    assert.ok(serial && /^[A-Za-z0-9_.:-]+$/.test(serial), 'Set an explicit TAVERN_BENCH_ADB_SERIAL');
    assert.equal(typeof WebSocket, 'function', 'This driver requires Node.js 22+ with built-in WebSocket');
    assert.equal(shell('getprop', 'ro.kernel.qemu'), '1', 'Refusing to operate on a physical Android device');
    const pidText = shell('pidof', packageName);
    assert.match(pidText, /^\d+$/, 'Open this app first; exactly one main process is required');
    const mainPid = Number(pidText), remote = `localabstract:webview_devtools_remote_${mainPid}`;
    const unixSockets = shell('cat', '/proc/net/unix');
    assert.ok(unixSockets.split('\n').some(line => line.trim().endsWith(`@webview_devtools_remote_${mainPid}`)), 'This app has no PID-matching WebView developer socket; use a test/debug build with WebView inspection enabled');
    report.target = { packageName, serial, mainPid, apiLevel: shell('getprop', 'ro.build.version.sdk'), abi: shell('getprop', 'ro.product.cpu.abi'),
        emulator: true, debuggerSocket: remote, origin,
        apk: shell('dumpsys', 'package', packageName).split('\n').map(line => line.trim()).filter(line => /^version(Code|Name)=/.test(line)) };
    await fs.mkdir(path.join(project, '.cache'), { recursive: true });
    reportPath = path.resolve(process.env.TAVERN_UI_REPORT_PATH || path.join(project, '.cache', `benchmark-webview-${fixture}.json`));
    const reservedReport = await fs.open(reportPath, 'wx'); await reservedReport.close();
    base = `http://127.0.0.1:${await forward('tcp:18766')}`;
    const devPort = await forward(remote);
    csrf = (await api('/csrf-token')).token;
    assert.equal(typeof csrf, 'string', 'Own emulator backend did not provide CSRF');
    const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const pages = targets.filter(item => {
        try { return item.type === 'page' && typeof item.url === 'string' && new URL(item.url).origin === origin; }
        catch { return false; }
    });
    assert.equal(pages.length, 1, 'Exactly one own-app local-origin WebView page is required');
    const debuggerUrl = new URL(pages[0].webSocketDebuggerUrl);
    assert.equal(debuggerUrl.protocol, 'ws:'); assert.ok(debuggerUrl.pathname.startsWith('/devtools/page/'));
    debuggerUrl.hostname = '127.0.0.1'; debuggerUrl.port = String(devPort);
    socket = new WebSocket(debuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Own-app WebView handshake timed out')); }, 10000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Own-app WebView connection failed')); }, { once: true });
    });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data), request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(`CDP command failed: ${message.error.code}`)) : request.resolve(message.result);
    });
    socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(new Error('Own-app WebView connection closed')); pending.clear(); });
    report.target.webview = await evaluate(setupPage, { key: qaKey, ownedAvatar: avatar }); pageStateCaptured = true;
    for (const item of await api('/api/characters/all', {})) priorAvatars.add(item.avatar);
    assert.ok(!priorAvatars.has(avatar), 'Fixture avatar already exists');
    for (const item of await api('/api/backups/chat/get', {})) priorBackups.add(item.file_name);
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: fixture, description: 'Disposable actual WebView UI benchmark fixture.',
        personality: '', scenario: '', first_mes: 'UI benchmark fixture', mes_example: '', creator_notes: 'Temporary emulator-only benchmark',
        system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['ui-benchmark'], creator: 'LocalTavern UI benchmark', character_version: '1.0', extensions: {} } };
    const form = new FormData(); form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${fixture}.json`);
    form.append('file_type', 'json'); form.append('preserved_name', avatar);
    fixtureImportAttempted = true;
    const imported = await api('/api/characters/import', form);
    assert.ok(!imported.error && typeof imported.file_name === 'string' && `${imported.file_name.replace(/\.png$/, '')}.png` === avatar, 'Fixture character import failed or changed identity');
    fixtureCreated = true;
    // Normal character selection opens /chats/get first. That endpoint creates
    // the character's chat directory; import intentionally expects it to exist.
    await api('/api/chats/get', { avatar_url: avatar });
    for (const count of report.workload.messageCounts) {
        checkInterrupted();
        const chat = [{ user_name: 'UI Benchmark User', character_name: fixture, chat_metadata: { integrity: randomUUID(), uiBenchmark: fixture } }];
        for (let i = 0; i < count; i++) {
            const markdown = `消息 ${i}: **本地聊天** 和世界书；Unicode 内容、段落、列表与 \`inline code\`。\n\n${'正常回复内容和上下文。Local API conversation sample. '.repeat(3)}\n- 第一项\n- 第二项`;
            chat.push({ name: i % 2 ? fixture : 'UI Benchmark User', is_user: i % 2 === 0, is_system: false,
                send_date: '2026-01-01T00:00:00Z', mes: i % 20 ? markdown : `${markdown}\n\n\`\`\`javascript\nconst messageIndex = ${i};\n\`\`\`` });
        }
        const jsonl = chat.map(item => JSON.stringify(item)).join('\n');
        const upload = new FormData(); upload.append('avatar_url', avatar); upload.append('character_name', `${fixture}_${count}`);
        upload.append('user_name', 'UI Benchmark User'); upload.append('file_type', 'jsonl');
        upload.append('avatar', new Blob([jsonl], { type: 'application/jsonl' }), `${fixture}_${count}.jsonl`);
        const result = await api('/api/chats/import', upload);
        assert.ok(result.res && result.fileNames?.length === 1, 'Fixture chat import failed');
        const file = result.fileNames[0];
        assert.ok(file.startsWith(`${fixture}_${count}`) && file.endsWith('.jsonl') && !/[/\\]/.test(file), 'Chat import escaped its fixture namespace');
        const chatName = file.slice(0, -6);
        const reread = await api('/api/chats/get', { avatar_url: avatar, file_name: chatName });
        assert.deepEqual(reread, chat, 'Actual API must retain all messages before any UI benchmark');
        importedChats.push({ count, chatName, utf8Bytes: Buffer.byteLength(jsonl), sha256: createHash('sha256').update(jsonl).digest('hex') });
    }
    await api('/api/characters/edit-attribute', { ch_name: fixture, avatar_url: avatar, field: 'chat', value: importedChats[0].chatName });
    await evaluate(preparePage, { key: qaKey });
    report.fixtureChats = importedChats;
    report.measurements.opens = [];
    report.heapScope = 'CDP Runtime.getHeapUsage for the inspected WebView V8 isolate; not total renderer PSS or device memory';
    report.heapBefore = await command('Runtime.getHeapUsage');
    if (process.env.TAVERN_UI_PROFILE === '1') {
        await command('Profiler.enable');
        await command('Profiler.setSamplingInterval', { interval: 1000 });
        await command('Profiler.start');
        profiling = true;
    }
    for (const chat of importedChats) {
        const samples = [];
        for (let index = 0; index < 4; index++) {
            checkInterrupted();
            const sample = await evaluate(measureOpen, { key: qaKey, chatName: chat.chatName, count: chat.count, select: chat === importedChats[0] && index === 0 });
            sample.cacheLabel = index === 0 ? 'First fixture open observed in this run; existing WebView/V8/cache state is not reset' : 'Repeated open in the same live WebView';
            sample.heapAfter = await command('Runtime.getHeapUsage');
            samples.push(sample);
        }
        report.measurements.opens.push({ messageCount: chat.count, first: samples[0], repeated: samples.slice(1),
            repeatedSummary: { chatChanged: summary(samples.slice(1).map(item => item.chatChangedMs)),
                actionTwoFrames: summary(samples.slice(1).map(item => item.twoFramesAfterActionMs)) } });
    }
    report.measurements.interactions = await evaluate(measureInteractions, { key: qaKey });
    report.heapAfter = await command('Runtime.getHeapUsage');
    if (profiling) {
        const { profile } = await command('Profiler.stop'); profiling = false;
        const profilePath = `${reportPath}.cpuprofile`;
        await fs.writeFile(profilePath, JSON.stringify(profile), { flag: 'wx' });
        report.cpuProfile = { path: profilePath, scope: 'Sampled target WebView JavaScript call stacks during this run; sampling adds overhead, so these timings are separate from the unprofiled baseline.' };
    }
    report.completed = true;
} catch (error) {
    report.error = error.message; process.exitCode = 1;
} finally {
    if (profiling && socket?.readyState === WebSocket.OPEN) {
        try { await command('Profiler.stop', {}, 2000); } catch { /* Still clean the owned fixtures if the page disconnected. */ }
    }
    let restored;
    if (pageStateCaptured) {
        try {
            restored = await evaluate(restorePage, { key: qaKey });
            report.cleanup.pageRestored = restored.restored; report.cleanup.page = restored;
            if (!restored.restored) report.cleanup.errors.push('Original page or draft could not be fully restored');
        } catch (error) { report.cleanup.errors.push(`Page restoration: ${error.message}`); }
    }
    // Do not delete an active fixture after a disconnected/failed restoration:
    // an outstanding frontend save could recreate it. Preserve only owned data
    // and explicitly report the unresolved cleanup instead of claiming success.
    if (!pageStateCaptured || restored?.restored) await cleanFixtures(restored);
    else if (fixtureCreated) report.cleanup.errors.push('Owned fixtures retained because WebView restoration did not finish');
    if (socket?.readyState === WebSocket.OPEN) {
        try { await command('Runtime.releaseObjectGroup', { objectGroup: fixture }, 2000); } catch { /* no remote objects are returned */ }
        socket.close();
    }
    for (const request of pending.values()) request.reject(new Error('UI benchmark finished')); pending.clear();
    removeForwards();
    process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
    if (report.cleanup.errors.length) { report.completed = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    const openSummary = report.measurements.opens?.map(item => ({ messages: item.messageCount, firstOpenMs: round(item.first.twoFramesAfterActionMs), repeated: item.repeatedSummary }));
    console.log(JSON.stringify({ completed: report.completed, fixture, reportPath, opens: openSummary,
        cleanup: report.cleanup, ...(report.error ? { error: report.error } : {}) }));
}
