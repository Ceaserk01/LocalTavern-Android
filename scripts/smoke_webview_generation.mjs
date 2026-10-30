// Real frontend generation against a fixture-only mock on a disposable emulator.
// TAVERN_UI_TEST_DISPOSABLE=1 TAVERN_BENCH_ADB_SERIAL=emulator-5554 \
//   node scripts/smoke_webview_generation.mjs
// Optional: TAVERN_BENCH_ADB_PATH, TAVERN_GENERATION_REPORT_PATH (must not exist).
// Requires a rooted QA emulator with its own PID-matching WebView developer socket.
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
const fixture = `ltgen_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const avatar = `${fixture}.png`;
const qaKey = `__${fixture}`;
const forwards = [];
const cookies = new Map();
const priorAvatars = new Set();
const priorBackups = new Set();
const report = {
    schemaVersion: 1, fixture, completed: false, startedAt: new Date().toISOString(),
    scope: 'Disposable own-app WebView extension API invokes actual upstream Generate, mock OpenAI SSE transport, stream rendering and chat persistence. CDP userGesture/synthetic actions do not establish trusted touch or IME. No paid API or original secret is sent to the mock.',
    driver: { node: process.version, platform: process.platform, arch: process.arch },
    workload: { actualFrontendGeneration: true, mockOnly: true, twoMemberListGroup: true, inMemoryQuickReplyExecution: true },
    measurements: {}, cleanup: { pageRestored: false, characterDeleted: false, backupsDeleted: 0, forwardsRemoved: 0, errors: [] },
};
let mock, mockPort, base, csrf, socket, nextId = 0, pageStateCaptured = false, fixtureCreated = false, fixtureImportAttempted = false, interrupted = false;
let reportPath, beforeSettingsHash, backupThrottle;
const replies = [];
const ownedCards = [], ownedGroups = [];
const fakeKey = `fake-${fixture}`;
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
        // Upstream exceptions are not ours to sanitize by truncation: return
        // only a bounded fixture enum, never arbitrary settings/draft content.
        const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'UI instrumentation failed';
        throw new Error(String(message).match(/\bQA_[A-Z0-9_]+\b/)?.[0] || 'QA_PAGE_EXCEPTION');
    }
    return result.result.value;
}

async function capture({ key, fixture, fakeKey, mockUrl }) {
    if (window[key] || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) throw new Error('QA_PAGE_NOT_READY');
    const script = await import('/script.js'), openai = await import('/scripts/openai.js');
    const context = SillyTavern.getContext();
    if (!script.settingsReady || !context.eventSource.autoFireLastArgs.has(context.eventTypes.APP_READY) || context.loader.isBlocking()
        || script.is_send_press || script.isChatSaving || document.querySelector('#curEditTextarea')) throw new Error('QA_PAGE_BUSY');
    const area = document.querySelector('#send_textarea');
    const q = window[key] = { script, openai, fixture, fakeKey, mockUrl, settingsWritesBlocked: 0, saves: [], partialRenders: [],
        original: { api: context.mainApi, online: context.onlineStatus, oai: structuredClone(openai.oai_settings),
            powerJSON: JSON.stringify(context.powerUserSettings), extensionJSON: JSON.stringify(context.extensionSettings),
            autoContinueEnabled: context.powerUserSettings.auto_continue.enabled, ttsEnabled: context.extensionSettings.tts?.enabled,
            quickReplyV2: context.extensionSettings.quickReplyV2,
            avatar: context.characters[context.characterId]?.avatar, groupId: context.groupId, chatId: context.chatId,
            draft: area.value, name2: context.name2,
            neutralChat: context.characterId === undefined && !context.groupId ? structuredClone(context.chat) : null,
            metadata: context.characterId === undefined && !context.groupId ? structuredClone(context.chatMetadata) : null },
        originalFetch: window.fetch };
    q.fetchWrapper = async function(resource, init) {
        const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
        if (url.origin !== location.origin) throw new Error('QA_EXTERNAL_REQUEST_BLOCKED');
        if (url.pathname === '/api/settings/save') { q.settingsWritesBlocked++; return new Response('{"result":"ok"}', { headers: { 'Content-Type': 'application/json' } }); }
        if (url.pathname.startsWith('/api/secrets/') && !['/api/secrets/read', '/api/secrets/find'].includes(url.pathname)) throw new Error('QA_SECRET_WRITE_BLOCKED');
        if (url.pathname.includes('/generate')) {
            if (url.pathname !== '/api/backends/chat-completions/generate') throw new Error('QA_NON_FIXTURE_MODEL_BLOCKED');
            const input = JSON.parse(init.body);
            const current = SillyTavern.getContext();
            if (!current.characters[current.characterId]?.name?.startsWith(fixture) && !current.groups.find(x => x.id === current.groupId)?.name?.startsWith(fixture)) throw new Error('QA_FOREIGN_CHAT_GENERATION_BLOCKED');
            let configuredHeaders;
            try { configuredHeaders = JSON.parse(input.custom_include_headers); } catch { throw new Error('QA_FRONTEND_HEADER_FORMAT'); }
            if (input.chat_completion_source !== 'custom' || input.custom_url !== mockUrl || input.model !== 'gpt-4'
                || input.stream !== true || configuredHeaders.Authorization !== `Bearer ${fakeKey}`
                || input.custom_include_body !== '' || input.custom_exclude_body !== '') throw new Error('QA_FRONTEND_MODEL_CONFIGURATION_MISMATCH');
            // An unknown ID prevents even selecting the app's active custom key.
            // Destination/header/model above must come from the real frontend.
            input.secret_id = fixture;
            init = { ...init, body: JSON.stringify(input) };
        }
        if (['/api/chats/save', '/api/chats/group/save'].includes(url.pathname)) q.saves.push(performance.now());
        return q.originalFetch.call(this, resource, init);
    };
    window.fetch = q.fetchWrapper;
    q.observer = new MutationObserver(() => {
        const text = document.querySelector('#chat .mes.last_mes .mes_text')?.textContent || document.querySelector('#chat .mes:last-child .mes_text')?.textContent || '';
        if (text.includes(fixture) && q.partialRenders.at(-1) !== text && q.partialRenders.length < 100) q.partialRenders.push(text);
    });
    q.observer.observe(document.querySelector('#chat'), { childList: true, characterData: true, subtree: true });
    return { captured: true, appReady: true, settingsKeptInPageMemoryOnly: true };
}

async function configure({ key, ownedAvatar }) {
    const q = window[key], context = SillyTavern.getContext();
    q.avatar = ownedAvatar;
    Object.assign(q.openai.oai_settings, { chat_completion_source: 'custom', custom_url: q.mockUrl, custom_model: 'gpt-4',
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${q.fakeKey}` }), custom_include_body: '', custom_exclude_body: '',
        stream_openai: true, bypass_status_check: true, openai_max_tokens: 128, openai_max_context: 4096,
        reverse_proxy: '', proxy_password: '', assistant_prefill: '', function_calling: false, n: 1 });
    context.powerUserSettings.auto_continue.enabled = false;
    if (context.extensionSettings.tts) context.extensionSettings.tts.enabled = false;
    q.script.changeMainAPI('openai'); q.script.setOnlineStatus('QA fixture mock');
    await q.script.getCharacters();
    const id = SillyTavern.getContext().characters.findIndex(x => x.avatar === ownedAvatar);
    if (id < 0) throw new Error('QA_CARD_NOT_DISCOVERED');
    await SillyTavern.getContext().selectCharacterById(id, { switchMenu: false });
    q.script.setOnlineStatus('QA fixture mock');
    return { selected: SillyTavern.getContext().characters[SillyTavern.getContext().characterId]?.avatar === ownedAvatar };
}

async function generate({ key, userText }) {
    const q = window[key], area = document.querySelector('#send_textarea');
    area.value = userText; area.dispatchEvent(new Event('input', { bubbles: true }));
    const start = performance.now();
    await SillyTavern.getContext().generate('normal');
    await SillyTavern.getContext().saveChat();
    const context = SillyTavern.getContext(), last = context.chat.at(-1);
    if (last?.is_user || !last?.mes?.includes(q.fixture)) throw new Error('QA_FINAL_RESPONSE_MISSING');
    const finalText = document.querySelector('#chat .mes:last-child .mes_text')?.textContent || '';
    return { elapsedMs: performance.now() - start, chatId: context.chatId, messageCount: context.chat.length,
        finalText: last.mes, domMatches: finalText.includes(last.mes),
        partialRenderCount: q.partialRenders.filter(text => text !== finalText && text.includes(q.fixture)).length,
        sendReset: !q.script.is_send_press && !context.streamingProcessor, savesObserved: q.saves.length };
}

async function quickReply({ key }) {
    const q = window[key], { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
    const { QuickReply } = await import('/scripts/extensions/quick-reply/src/QuickReply.js');
    const set = QuickReplySet.from({ name: `${q.fixture}_memory_qr`, disableSend: true, injectInput: false });
    const reply = QuickReply.from({ id: 1, label: 'QA macro', message: `${q.fixture} says hello to {{char}}`, preventAutoExecute: true });
    set.qrList.push(reply); set.hookQuickReply(reply);
    await reply.execute();
    const area = document.querySelector('#send_textarea');
    const macroExpanded = area.value.trim() === `${q.fixture} says hello to ${q.fixture}`;
    if (!macroExpanded) throw new Error('QA_QUICK_REPLY_MACRO_FAILED');
    set.disableSend = false; reply.message = `/pass ${q.fixture}_slash_pipe`;
    const pipe = await reply.execute({}, false, true);
    if (pipe !== `${q.fixture}_slash_pipe`) throw new Error('QA_QUICK_REPLY_SLASH_PIPE_FAILED');
    area.value = ''; area.dispatchEvent(new Event('input', { bubbles: true }));
    return { actualQuickReplyClasses: true, macroExpanded, slashCommandPipeMatches: true, inMemoryOnly: true };
}

async function generateGroup({ key, groupId, userText, ownedAvatars }) {
    const q = window[key], groups = await import('/scripts/group-chats.js');
    q.ownedAvatars = ownedAvatars;
    await q.script.getCharacters(); await groups.getGroups();
    if (!await groups.openGroupById(groupId)) throw new Error('QA_GROUP_OPEN_FAILED');
    q.script.setOnlineStatus('QA fixture mock');
    const area = document.querySelector('#send_textarea'); area.value = userText; area.dispatchEvent(new Event('input', { bubbles: true }));
    const before = SillyTavern.getContext().chat.length, start = performance.now();
    await SillyTavern.getContext().generate('normal'); await SillyTavern.getContext().saveChat();
    const context = SillyTavern.getContext(), added = context.chat.slice(before), replies = added.filter(x => !x.is_user && !x.is_system);
    if (replies.length !== 2 || !added.some(x => x.is_user && x.mes === userText)) throw new Error('QA_GROUP_REPLY_COUNT');
    const dom = [...document.querySelectorAll('#chat .mes .mes_text')].map(x => x.textContent);
    return { elapsedMs: performance.now() - start, chatId: context.chatId, members: replies.map(x => x.name),
        texts: replies.map(x => x.mes), domContainsBothReplies: replies.every(x => dom.some(y => y.includes(x.mes))),
        sendReset: !q.script.is_send_press && !groups.is_group_generating && !context.streamingProcessor };
}

async function restore({ key }) {
    const q = window[key];
    if (!q) return { restored: false };
    const script = q.script, original = q.original, groups = await import('/scripts/group-chats.js');
    const utils = await import('/scripts/utils.js');
    if (script.is_send_press) { SillyTavern.getContext().stopGeneration(); throw new Error('QA_GENERATION_STILL_ACTIVE'); }
    script.cancelDebouncedChatSave(); (await import('/scripts/extensions.js')).cancelDebouncedMetadataSave?.();
    utils.cancelDebounce(script.saveSettingsDebounced);
    const replace = (target, value) => { for (const name of Object.keys(target)) delete target[name]; Object.assign(target, structuredClone(value)); };
    replace(q.openai.oai_settings, original.oai);
    SillyTavern.getContext().powerUserSettings.auto_continue.enabled = original.autoContinueEnabled;
    if (SillyTavern.getContext().extensionSettings.tts) SillyTavern.getContext().extensionSettings.tts.enabled = original.ttsEnabled;
    script.changeMainAPI(original.api); script.setOnlineStatus(original.online);
    if (original.groupId) {
        await groups.openGroupById(original.groupId);
        if (SillyTavern.getContext().chatId !== original.chatId) await SillyTavern.getContext().openGroupChat(original.groupId, original.chatId);
    } else if (original.avatar) {
        const id = SillyTavern.getContext().characters.findIndex(x => x.avatar === original.avatar);
        if (id < 0) throw new Error('QA_ORIGINAL_CARD_MISSING');
        await SillyTavern.getContext().selectCharacterById(id, { switchMenu: false });
        if (original.chatId && SillyTavern.getContext().chatId !== original.chatId) await SillyTavern.getContext().openCharacterChat(original.chatId);
    } else {
        await script.clearChat({ clearData: true }); groups.resetSelectedGroup(); script.resetChatState();
        script.setActiveCharacter(null); script.setActiveGroup(null); script.setCharacterName(original.name2);
        script.chat.splice(0, script.chat.length, ...original.neutralChat); script.updateChatMetadata(original.metadata, true);
        await script.getCharacters(); await script.printMessages(); await script.eventSource.emit(script.event_types.CHAT_CHANGED, script.getCurrentChatId());
    }
    utils.cancelDebounce(script.saveSettingsDebounced);
    const area = document.querySelector('#send_textarea'); area.value = original.draft; area.dispatchEvent(new Event('input', { bubbles: true }));
    const now = SillyTavern.getContext();
    // Normal character selection creates an empty in-memory character QR config,
    // and normal message events may normalize quickReplyV2 via settings.save().
    // Keep its original live value and remove only our temporary empty config.
    const qr = await import('/scripts/extensions/quick-reply/index.js');
    if (qr.quickReplyApi?.settings?.characterConfigs) for (const item of q.ownedAvatars || [q.avatar]) delete qr.quickReplyApi.settings.characterConfigs[item];
    now.extensionSettings.quickReplyV2 = Object.hasOwn(original, 'quickReplyV2') ? original.quickReplyV2 : JSON.parse(original.extensionJSON).quickReplyV2;
    const restored = area.value === original.draft && now.mainApi === original.api && now.onlineStatus === original.online
        && JSON.stringify(q.openai.oai_settings) === JSON.stringify(original.oai)
        && JSON.stringify(now.powerUserSettings) === original.powerJSON && JSON.stringify(now.extensionSettings) === original.extensionJSON
        && (original.groupId ? now.groupId === original.groupId && now.chatId === original.chatId
            : original.avatar ? now.characters[now.characterId]?.avatar === original.avatar && now.chatId === original.chatId : now.characterId === undefined && !now.groupId);
    q.observer.disconnect();
    const result = { restored, settingsWritesBlocked: q.settingsWritesBlocked, ownedChatSaveWrites: q.saves.length,
        msSinceLastOwnedChatSave: q.saves.length ? performance.now() - q.saves.at(-1) : null };
    if (restored) { if (window.fetch === q.fetchWrapper) window.fetch = q.originalFetch; delete window[key]; }
    return result;
}

async function cleanFixtures(restored) {
    if (!base || !csrf || !fixtureImportAttempted || !restored?.restored) return;
    if (restored.ownedChatSaveWrites) {
        const wait = Math.max(0, backupThrottle + 1500 - restored.msSinceLastOwnedChatSave); if (wait) await delay(wait);
    }
    for (const entry of await api('/api/backups/chat/get', {})) {
        if (!priorBackups.has(entry.file_name) && String(entry.file_name).startsWith(`chat_${fixture}_`) && !/[/\\]/.test(entry.file_name)) {
            await api('/api/backups/chat/delete', { name: entry.file_name }); report.cleanup.backupsDeleted++;
        }
    }
    for (const own of ownedGroups) {
        const current = (await api('/api/groups/all', {})).find(x => x.id === own.id && x.name === own.name);
        if (current) await api('/api/groups/delete', { id: own.id });
        assert.deepEqual(await api('/api/chats/group/get', { id: own.chat_id }), [], 'QA_GROUP_CHAT_CLEANUP_FAILED');
    }
    for (const own of ownedCards) {
        const current = (await api('/api/characters/all', {})).find(x => x.avatar === own.avatar && x.name === own.name && !priorAvatars.has(x.avatar));
        if (current) await api('/api/characters/delete', { avatar_url: own.avatar, delete_chats: true });
    }
    assert.ok(!(await api('/api/characters/all', {})).some(x => ownedCards.some(y => y.avatar === x.avatar)), 'QA_CARD_CLEANUP_FAILED');
    assert.ok(!(await api('/api/groups/all', {})).some(x => ownedGroups.some(y => y.id === x.id)), 'QA_GROUP_CLEANUP_FAILED');
    report.cleanup.characterDeleted = ownedCards.length > 0; report.cleanup.charactersDeleted = ownedCards.length; report.cleanup.groupsDeleted = ownedGroups.length;
    report.cleanup.noOwnedFixturesRemain = true;
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
    reportPath = path.resolve(process.env.TAVERN_GENERATION_REPORT_PATH || path.join(project, '.cache', `smoke-webview-generation-${fixture}.json`));
    const reservedReport = await fs.open(reportPath, 'wx'); await reservedReport.close();
    base = `http://127.0.0.1:${await forward('tcp:18766')}`;
    const devPort = await forward(remote);
    csrf = (await api('/csrf-token')).token;
    assert.equal(typeof csrf, 'string', 'Own emulator backend did not provide CSRF');
    // Signed release packages cannot use run-as. Read only this disposable QA
    // app's backup throttle through the emulator's existing su facility, before
    // changing any page/data, so fixture cleanup cannot race delayed backups.
    let config;
    try { config = shell('su', '0', 'cat', '/data/user/0/app.local.tavern/files/userdata/config.yaml'); }
    catch { throw new Error('QA_ROOTED_EMULATOR_REQUIRED_FOR_BOUNDED_BACKUP_CLEANUP'); }
    const throttleMatch = config.match(/^    throttleInterval:\s*(\d+)\s*(?:#.*)?$/m);
    assert.ok(throttleMatch, 'QA_BACKUP_THROTTLE_UNKNOWN'); backupThrottle = Number(throttleMatch[1]);
    assert.ok(backupThrottle <= 60000, 'QA_BACKUP_THROTTLE_TOO_LONG');
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
    mock = http.createServer(async (req, res) => {
        try {
            assert.equal(req.headers.authorization, `Bearer ${fakeKey}`, 'QA_MOCK_AUTH_MUST_BE_FAKE');
            if (req.method === 'GET' && req.url === '/v1/models') {
                res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"gpt-4"}]}'); return;
            }
            assert.equal(req.url, '/v1/chat/completions', 'QA_MOCK_PATH');
            let size = 0, body = '';
            for await (const chunk of req) { size += chunk.length; assert.ok(size <= 1024 * 1024, 'QA_MOCK_REQUEST_TOO_LARGE'); body += chunk; }
            const value = JSON.parse(body);
            assert.equal(value.model, 'gpt-4', 'QA_MODEL'); assert.equal(value.stream, true, 'QA_STREAM_REQUIRED');
            assert.ok(JSON.stringify(value.messages).includes(fixture), 'QA_OWN_PROMPT_REQUIRED');
            const answer = `${fixture} answer ${replies.length + 1}: 本地流式成功。`;
            replies.push({ answer, stream: true, fakeAuthorization: true, ownPrompt: true, model: 'gpt-4' });
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            for (const text of [fixture, ` answer ${replies.length}`, ': 本地', '流式', '成功。']) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
                await delay(180);
            }
            res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        } catch { report.mockFailure = true; res.statusCode = 400; res.end('QA_MOCK_GUARD_FAILED'); }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); mockPort = mock.address().port;
    // The stock Android emulator's 10.0.2.2 route reaches only this loopback mock.
    const mockUrl = `http://10.0.2.2:${mockPort}/v1`;
    beforeSettingsHash = createHash('sha256').update((await api('/api/settings/get', {})).settings).digest('hex');
    checkInterrupted();
    report.target.webview = await evaluate(capture, { key: qaKey, fixture, fakeKey, mockUrl }); pageStateCaptured = true;
    for (const item of await api('/api/characters/all', {})) priorAvatars.add(item.avatar);
    for (const item of await api('/api/backups/chat/get', {})) priorBackups.add(item.file_name);
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: fixture, description: `Own fixture ${fixture}`, personality: '友好',
        scenario: '本地生成测试', first_mes: `${fixture} greeting`, mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } };
    const form = new FormData(); form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${fixture}.json`);
    form.append('file_type', 'json'); fixtureImportAttempted = true;
    const imported = await api('/api/characters/import', form);
    assert.equal(imported.file_name, fixture, 'QA_CARD_NAME'); fixtureCreated = true; ownedCards.push({ name: fixture, avatar });
    assert.equal((await evaluate(configure, { key: qaKey, ownedAvatar: avatar })).selected, true, 'QA_SELECTION');
    checkInterrupted();
    report.measurements.solo = await evaluate(generate, { key: qaKey, userText: `${fixture}: 你好，请回复。` });
    assert.equal(replies.length, 1, 'QA_EXACT_ONE_MODEL_REQUEST');
    assert.equal(report.measurements.solo.finalText, replies[0].answer, 'QA_RENDERED_FINAL_TEXT');
    assert.equal(report.measurements.solo.domMatches, true, 'QA_RENDERED_DOM');
    assert.equal(report.measurements.solo.sendReset, true, 'QA_SOLO_SEND_STATE_RESET');
    assert.ok(report.measurements.solo.partialRenderCount > 0, 'QA_INCREMENTAL_STREAM_RENDER');
    const saved = await api('/api/chats/get', { avatar_url: avatar, file_name: report.measurements.solo.chatId });
    assert.equal(saved.at(-1).mes, replies[0].answer, 'QA_SAVED_ASSISTANT');
    assert.equal(saved.at(-2).mes, `${fixture}: 你好，请回复。`, 'QA_SAVED_USER');
    report.measurements.solo.savedFinalMatches = true;
    checkInterrupted();
    report.measurements.quickReply = await evaluate(quickReply, { key: qaKey });
    assert.equal(replies.length, 1, 'QA_QR_MUST_NOT_CALL_MODEL');
    const secondName = `${fixture}_B`, secondAvatar = `${secondName}.png`;
    const secondCard = structuredClone(card); secondCard.data.name = secondName; secondCard.data.first_mes = `${secondName} greeting`;
    const secondForm = new FormData(); secondForm.append('avatar', new Blob([JSON.stringify(secondCard)], { type: 'application/json' }), `${secondName}.json`);
    secondForm.append('file_type', 'json');
    const secondImported = await api('/api/characters/import', secondForm); assert.equal(secondImported.file_name, secondName, 'QA_SECOND_CARD_NAME');
    ownedCards.push({ name: secondName, avatar: secondAvatar });
    const groupName = `${fixture}_group`, groupChat = `${fixture}_groupchat`;
    const group = await api('/api/groups/create', { name: groupName, members: [avatar, secondAvatar], disabled_members: [],
        chat_id: groupChat, chats: [groupChat], allow_self_responses: true, activation_strategy: 1, generation_mode: 0, auto_mode_delay: 7 });
    assert.equal(group.name, groupName, 'QA_GROUP_NAME'); ownedGroups.push({ id: group.id, name: groupName, chat_id: groupChat });
    checkInterrupted();
    report.measurements.group = await evaluate(generateGroup, { key: qaKey, groupId: group.id, ownedAvatars: [avatar, secondAvatar], userText: `${fixture}: 两位请依次回复。` });
    assert.equal(replies.length, 3, 'QA_GROUP_EXACT_TWO_REQUESTS');
    assert.deepEqual(report.measurements.group.members, [fixture, secondName], 'QA_GROUP_LIST_ORDER');
    assert.deepEqual(report.measurements.group.texts, replies.slice(1).map(x => x.answer), 'QA_GROUP_FINAL_TEXTS');
    assert.equal(report.measurements.group.domContainsBothReplies, true, 'QA_GROUP_DOM');
    assert.equal(report.measurements.group.sendReset, true, 'QA_GROUP_SEND_STATE_RESET');
    const savedGroup = await api('/api/chats/group/get', { id: groupChat });
    assert.deepEqual(savedGroup.slice(-2).map(x => x.mes), replies.slice(1).map(x => x.answer), 'QA_GROUP_SAVED_FINAL_TEXTS');
    report.measurements.group.savedBothFinalMatches = true;
    report.mock = replies.map(({ answer, ...bounded }) => bounded);
    report.completed = true;
} catch (error) {
    // Throw sites deliberately contain fixture diagnostics only; never return page settings or draft data.
    report.error = String(error.message).slice(0, 600); process.exitCode = 1;
} finally {
    let restored;
    if (pageStateCaptured) {
        try { restored = await evaluate(restore, { key: qaKey }); report.cleanup.pageRestored = restored.restored; report.cleanup.page = restored; }
        catch (error) { report.cleanup.errors.push(`Page restoration: ${error.message}`); }
    }
    if (restored?.restored) {
        try { await cleanFixtures(restored); } catch (error) { report.cleanup.errors.push(error.message); }
    } else if (pageStateCaptured) report.cleanup.errors.push('QA_PAGE_NOT_RESTORED_FIXTURE_RETAINED');
    if (base && beforeSettingsHash) {
        try {
            const after = createHash('sha256').update((await api('/api/settings/get', {})).settings).digest('hex');
            report.cleanup.persistedSettingsByteExact = beforeSettingsHash === after;
            if (!report.cleanup.persistedSettingsByteExact) report.cleanup.errors.push('QA_PERSISTED_SETTINGS_CHANGED');
        } catch { report.cleanup.errors.push('QA_SETTINGS_VERIFICATION_FAILED'); }
    }
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    for (const request of pending.values()) request.reject(new Error('QA_FINISHED')); pending.clear();
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
    removeForwards(); process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
    if (report.cleanup.errors.length || report.mockFailure) { report.completed = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ completed: report.completed, fixture, reportPath, measurements: report.measurements, cleanup: report.cleanup,
        ...(report.error ? { error: report.error } : {}) }));
}
