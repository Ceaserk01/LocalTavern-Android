// Official TavernHelper compatibility fixture on a disposable rooted emulator.
// TAVERN_UI_TEST_DISPOSABLE=1 TAVERN_BENCH_ADB_SERIAL=emulator-5554 \
//   node scripts/smoke_tavern_helper.mjs
// Prepare the pinned official checkout described in docs/compatibility/TAVERN_HELPER.md.
// Optional: TAVERN_HELPER_CHECKOUT, TAVERN_BENCH_ADB_PATH,
// TAVERN_HELPER_REPORT_PATH (must not exist). No model or clipboard access.
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
const fixture = `lthelper_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const avatar = `${fixture}.png`;
const qaKey = `__${fixture}`;
const forwards = [];
const cookies = new Map();
const priorAvatars = new Set();
const priorBackups = new Set();
const report = {
    schemaVersion: 1, fixture, completed: false, startedAt: new Date().toISOString(),
    scope: 'Actual official TavernHelper Git install and unmodified distJS inside signed Android APK; helper globals, srcdoc/blob HTML message frames, helper script iframe APIs and Slash/variable bridge. Disposable rooted emulator only; no paid model API, host clipboard, or physical-phone claim.',
    driver: { node: process.version, platform: process.platform, arch: process.arch },
    workload: { officialPlugin: true, messageIframe: true, scriptIframe: true, noModelApi: true },
    measurements: {}, cleanup: { pageRestored: false, characterDeleted: false, backupsDeleted: 0, forwardsRemoved: 0, errors: [] },
};
let mock, mockPort, base, csrf, socket, nextId = 0, pageStateCaptured = false, fixtureCreated = false, fixtureImportAttempted = false, interrupted = false;
let reportPath, beforeSettingsHash, backupThrottle;
const replies = [];
const ownedCards = [], ownedGroups = [];
const fakeKey = `fake-${fixture}`;
const extensionName = 'JS-Slash-Runner', extensionId = 'third-party/JS-Slash-Runner';
const officialUrl = 'https://github.com/N0VI028/JS-Slash-Runner';
const officialVersion = '4.11.3';
const officialCommit = 'ecd74c73518f6607387bed95a966fc1e2b8057c7';
const officialDistSha256 = '73cd44e6f44634642777edacbd358146d173c14abfec6aece73e4d8517e449cb';
const helperCheckout = path.resolve(process.env.TAVERN_HELPER_CHECKOUT || path.join(project, '.cache/tavern-helper'));
let extensionInstalled = false, originalPageState, pluginUnmounted = false;
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
        body: body === undefined || form ? body : JSON.stringify(body), signal: AbortSignal.timeout(endpoint === "/api/extensions/install" ? 600000 : 30000),
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
            powerClone: structuredClone(context.powerUserSettings), autoContinueEnabled: context.powerUserSettings.auto_continue.enabled, ttsEnabled: context.extensionSettings.tts?.enabled,
            quickReplyV2: context.extensionSettings.quickReplyV2, helperSettingPresent: Object.hasOwn(context.extensionSettings, 'tavern_helper'), helperSetting: context.extensionSettings.tavern_helper, thirdParty: { helper: window.TavernHelper, z: window.z, YAML: window.YAML },
            avatar: context.characters[context.characterId]?.avatar, groupId: context.groupId, chatId: context.chatId,
            draft: area.value, name2: context.name2,
            neutralChat: context.characterId === undefined && !context.groupId ? structuredClone(context.chat) : null,
            metadata: context.characterId === undefined && !context.groupId ? structuredClone(context.chatMetadata) : null },
        originalFetch: window.fetch };
    q.fetchWrapper = async function(resource, init) {
        const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
        if (url.origin !== location.origin) { q.externalRequestsBlocked = (q.externalRequestsBlocked || 0) + 1; throw new Error('QA_EXTERNAL_REQUEST_BLOCKED'); }
        if (url.pathname === '/api/settings/save') { q.settingsWritesBlocked++; return new Response('{"result":"ok"}', { headers: { 'Content-Type': 'application/json' } }); }
        if (url.pathname.startsWith('/api/secrets/') && !['/api/secrets/read', '/api/secrets/find'].includes(url.pathname)) throw new Error('QA_SECRET_WRITE_BLOCKED');
        if (url.pathname.includes('/generate')) throw new Error('QA_MODEL_API_NOT_ALLOWED');
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

async function restore({ key }) {
    const q = window[key];
    if (!q) return { restored: false };
    const context = SillyTavern.getContext();
    const replacePower = (target, value) => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, structuredClone(value)); };
    replacePower(context.powerUserSettings, q.original.powerClone);
    if (q.original.helperSettingPresent) context.extensionSettings.tavern_helper = q.original.helperSetting; else delete context.extensionSettings.tavern_helper;
    for (const [key, value] of Object.entries(q.original.thirdParty)) { const name = key === 'helper' ? 'TavernHelper' : key; if (value === undefined) delete window[name]; else window[name] = value; }
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
    try {
        const commit = execFileSync('git', ['-C', helperCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const metadata = JSON.parse(await fs.readFile(path.join(helperCheckout, 'manifest.json'), 'utf8'));
        const distSha = createHash('sha256').update(await fs.readFile(path.join(helperCheckout, 'dist/index.js'))).digest('hex');
        assert.equal(commit, officialCommit); assert.equal(metadata.version, officialVersion); assert.equal(distSha, officialDistSha256);
    } catch { throw new Error('QA_PINNED_HELPER_CHECKOUT_UNAVAILABLE_OR_CHANGED'); }
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
    reportPath = path.resolve(process.env.TAVERN_HELPER_REPORT_PATH || path.join(project, '.cache', `helper-apk-qa-${fixture}.json`));
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
    const found = await api('/api/extensions/discover');
    assert.ok(!found.some(x => x.name === extensionId || String(x.name).toLowerCase().endsWith('/js-slash-runner')), 'QA_HELPER_ALREADY_INSTALLED');
    beforeSettingsHash = createHash('sha256').update((await api('/api/settings/get', {})).settings).digest('hex');
    report.preflight = await evaluate(capture, { key: qaKey, fixture, fakeKey, mockUrl: '' }); pageStateCaptured = true;
    originalPageState = await evaluate(({ key }) => { const o = window[key].original; return { avatar: o.avatar, groupId: o.groupId,
        chatId: o.chatId, name2: o.name2, draft: o.draft, neutralChat: o.neutralChat, metadata: o.metadata }; }, { key: qaKey });
    assert.equal(await evaluate(() => typeof window.TavernHelper), 'undefined', 'QA_HELPER_RUNTIME_ALREADY_PRESENT');
    for (const item of await api('/api/characters/all', {})) priorAvatars.add(item.avatar);
    for (const item of await api('/api/backups/chat/get', {})) priorBackups.add(item.file_name);
    const install = await api('/api/extensions/install', { url: officialUrl, global: false, branch: '' });
    assert.equal(install.folderName, extensionName, 'QA_OFFICIAL_INSTALL_NAME'); extensionInstalled = true;
    const info = await api('/api/extensions/version', { extensionName, global: false });
    report.plugin = { source: officialUrl, extensionName, version: install.version, currentCommitHash: info.currentCommitHash, currentBranchName: info.currentBranchName };
    assert.equal(install.version, officialVersion, 'QA_OFFICIAL_VERSION_CHANGED');
    assert.equal(info.currentCommitHash, officialCommit, 'QA_OFFICIAL_COMMIT_CHANGED');
    const actualDist = await api('/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js');
    report.plugin.distSha256 = createHash('sha256').update(actualDist).digest('hex');
    assert.equal(report.plugin.distSha256, officialDistSha256, 'QA_OFFICIAL_DIST_CHANGED');
    await evaluate(async () => { const extensions = await import('/scripts/extensions.js'); await extensions.loadExtensionSettings({}, false, false); return true; });
    for (let i = 0; i < 150; i++) {
        if (await evaluate(() => Boolean(window.TavernHelper && document.querySelector('#tavern_helper')?.__vue_app__))) break;
        if (i === 149) throw new Error('QA_OFFICIAL_DIST_NOT_INITIALIZED'); await delay(200);
    }
    report.initialization = await evaluate(() => ({ helperGlobal: typeof TavernHelper.getVariables === 'function',
        pluginVersion: TavernHelper.getTavernHelperVersion(), upstreamVersion: TavernHelper.getTavernVersion(),
        vueMounted: Boolean(document.querySelector('#tavern_helper')?.__vue_app__), tauriAbsent: window.__TAURITAVERN__ === undefined }));
    const html = `<!DOCTYPE html><html><head><style>body{padding:8px}#helper-fixture{color:rgb(4,85,136)}</style></head><body><button id="helper-fixture">${fixture}</button><script>
      (async()=>{const state=window.parent[${JSON.stringify(qaKey)}];
      const vars=getVariables({type:'chat'});insertOrAssignVariables({[${JSON.stringify(fixture)}]:'bridge-ok'},{type:'chat'});
      const slash=await triggerSlash('/pass ${fixture}');
      let events=0;eventOn('${fixture}_event',()=>events++);await eventEmit('${fixture}_event');eventClearEvent('${fixture}_event');
      state.frameResults={apiAvailable:typeof getChatMessages==='function'&&typeof eventOn==='function',contextMatches:SillyTavern.getContext().characters[SillyTavern.getContext().characterId]?.name===${JSON.stringify(fixture)},variableRoundtrip:getVariables({type:'chat'})[${JSON.stringify(fixture)}]==='bridge-ok',slashMatches:slash===${JSON.stringify(fixture)},eventRoundtrip:events===1,iframeNameMatches:getIframeName().startsWith('TH-message--'),originKind:location.href.startsWith('blob:')?'blob':location.href==='about:srcdoc'?'srcdoc':'other'};
      document.getElementById('helper-fixture').addEventListener('click',()=>{state.frameResults.buttonActivated=true;});
      })().catch(()=>window.parent[${JSON.stringify(qaKey)}].frameResults={failed:true});
    </script></body></html>`;
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: fixture, description: fixture, personality: '', scenario: '',
        first_mes: '```html\n'+html+'\n```', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } };
    const form = new FormData(); form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${fixture}.json`); form.append('file_type', 'json');
    fixtureImportAttempted = true; const imported = await api('/api/characters/import', form); assert.equal(imported.file_name, fixture, 'QA_CARD_NAME');
    fixtureCreated = true; ownedCards.push({ name: fixture, avatar });
    await evaluate(async ({ key, ownedAvatar }) => { const q=window[key];q.avatar=ownedAvatar;await q.script.getCharacters();
        const id=SillyTavern.getContext().characters.findIndex(x=>x.avatar===ownedAvatar);if(id<0)throw new Error('QA_CARD_MISSING');
        await SillyTavern.getContext().selectCharacterById(id,{switchMenu:false}); return true; }, { key: qaKey, ownedAvatar: avatar });
    async function waitFrame(kind) {
        for (let i = 0; i < 200; i++) {
            const value = await evaluate(({ key }) => window[key]?.frameResults || null, { key: qaKey });
            if (value?.failed) throw new Error('QA_HELPER_FRAME_SCRIPT_FAILED');
            if (value?.originKind === kind) return value;
            if (i === 199) throw new Error(`QA_HELPER_${kind.toUpperCase()}_FRAME_TIMEOUT`); await delay(200);
        }
    }
    report.messageSrcdoc = await waitFrame('srcdoc');
    for (const [key, value] of Object.entries(report.messageSrcdoc)) if (key !== 'originKind') assert.equal(value, true, `QA_SRCDOC_${key}`);
    report.messageSrcdoc.buttonActivated = await evaluate(({key}) => { const frame=[...document.querySelectorAll('iframe[id^="TH-message--"]')].find(x=>x.contentDocument?.getElementById('helper-fixture'));
        if(!frame)throw new Error('QA_MESSAGE_FRAME_NOT_FOUND');frame.contentDocument.getElementById('helper-fixture').click();return window[key].frameResults.buttonActivated===true; },{key:qaKey});
    assert.equal(report.messageSrcdoc.buttonActivated,true,'QA_HELPER_BUTTON_HANDLER');
    await evaluate(({ key }) => { const app=document.querySelector('#tavern_helper').__vue_app__,p=app._context.provides;
        const pinia=Reflect.ownKeys(p).map(k=>p[k]).find(x=>x?._s?.has?.('global_settings'));
        if(!pinia)throw new Error('QA_HELPER_PINIA_NOT_FOUND');window[key].frameResults=null;pinia._s.get('global_settings').settings.render.use_blob_url=true;return true; }, { key: qaKey });
    report.messageBlob = await waitFrame('blob');
    for (const [key, value] of Object.entries(report.messageBlob)) if (key !== 'originKind') assert.equal(value, true, `QA_BLOB_${key}`);
    const scriptContent = `const state=window.parent[${JSON.stringify(qaKey)}];try{const result=await triggerSlash('/pass ${fixture}_script');insertOrAssignVariables({flag:'script-ok'},{type:'script'});state.scriptResult={slashMatches:result===${JSON.stringify(fixture+'_script')},scriptVariableRoundtrip:getVariables({type:'script'}).flag==='script-ok',scriptIdMatches:getScriptId()===${JSON.stringify(fixture)},contextMatches:SillyTavern.getContext().characters[SillyTavern.getContext().characterId]?.name===${JSON.stringify(fixture)}};}catch{state.scriptResult={failed:true};}`;
    await evaluate(({ key, scriptContent, fixture }) => { const q=window[key];q.scriptResult=null;
        if(TavernHelper.getScriptTrees({type:'global'}).length)throw new Error('QA_EXISTING_HELPER_SCRIPTS');
        TavernHelper.replaceScriptTrees([{type:'script',enabled:true,id:fixture,name:fixture,content:scriptContent}],{type:'global'});return true; }, { key: qaKey, scriptContent, fixture });
    for (let i = 0; i < 200; i++) {
        const value=await evaluate(({key})=>window[key]?.scriptResult||null,{key:qaKey});
        if(value?.failed)throw new Error('QA_HELPER_GLOBAL_SCRIPT_FAILED');
        if(value){report.scriptIframe=value;break;} if(i===199)throw new Error('QA_HELPER_GLOBAL_SCRIPT_TIMEOUT');await delay(200);
    }
    for(const [key,value]of Object.entries(report.scriptIframe))assert.equal(value,true,`QA_SCRIPT_${key}`);
    await evaluate(async () => { await SillyTavern.getContext().saveChat();return true; });
    const ownChat=await evaluate(()=>SillyTavern.getContext().chatId);
    const saved=await api('/api/chats/get',{avatar_url:avatar,file_name:ownChat});
    report.persistedChatVariable = saved[0]?.chat_metadata?.variables?.[fixture] === 'bridge-ok';
    assert.equal(report.persistedChatVariable,true,'QA_HELPER_CHAT_VARIABLE_PERSISTENCE');
    report.completed=true;
} catch(error) { report.error=String(error.message).slice(0,400);process.exitCode=1; }
finally {
    let restored;
    if(pageStateCaptured) {
        try { pluginUnmounted=await evaluate(()=>{const app=document.querySelector('#tavern_helper')?.__vue_app__;if(app)app.unmount();document.querySelector('#tavern_helper')?.remove();return true;});
            restored=await evaluate(restore,{key:qaKey});report.cleanup.pageRestored=restored.restored;report.cleanup.page=restored; }
        catch(error){report.cleanup.errors.push(`QA_PAGE_RESTORE:${error.message}`);}
    }
    if(restored?.restored) { try{await cleanFixtures(restored);}catch(error){report.cleanup.errors.push(error.message);} }
    else if(pageStateCaptured)report.cleanup.errors.push('QA_PAGE_NOT_RESTORED_FIXTURE_RETAINED');
    if(extensionInstalled) {
        try { await api('/api/extensions/delete',{extensionName,global:false});
            report.cleanup.officialExtensionRemoved=!(await api('/api/extensions/discover')).some(x=>x.name===extensionId); }
        catch{report.cleanup.errors.push('QA_EXTENSION_CLEANUP_FAILED');}
    }
    if(pageStateCaptured&&restored?.restored) {
        try { const oldOrigin=await evaluate(()=>performance.timeOrigin);await command('Page.reload');
            for(let i=0;i<150;i++){let ready=false;try{ready=await evaluate(old=>Boolean(performance.timeOrigin!==old&&window.SillyTavern?.getContext&&SillyTavern.getContext().eventSource.autoFireLastArgs.has(SillyTavern.getContext().eventTypes.APP_READY)),oldOrigin);}catch{/* Expected destroyed-context transition during navigation. */}if(ready)break;
                if(i===149)throw new Error('QA_RELOAD_TIMEOUT');await delay(200);}
            report.cleanup.afterReload=await evaluate(async o=>{const script=await import('/script.js'),groups=await import('/scripts/group-chats.js');
                if(o.groupId){await groups.openGroupById(o.groupId);if(SillyTavern.getContext().chatId!==o.chatId)await SillyTavern.getContext().openGroupChat(o.groupId,o.chatId);}
                else if(o.avatar){const id=SillyTavern.getContext().characters.findIndex(x=>x.avatar===o.avatar);if(id<0)throw new Error('QA_ORIGINAL_CARD_MISSING');await SillyTavern.getContext().selectCharacterById(id,{switchMenu:false});if(o.chatId&&SillyTavern.getContext().chatId!==o.chatId)await SillyTavern.getContext().openCharacterChat(o.chatId);}
                else{await script.clearChat({clearData:true});groups.resetSelectedGroup();script.resetChatState();script.setActiveCharacter(null);script.setActiveGroup(null);script.setCharacterName(o.name2);script.chat.splice(0,script.chat.length,...o.neutralChat);script.updateChatMetadata(o.metadata,true);await script.getCharacters();await script.printMessages();await script.eventSource.emit(script.event_types.CHAT_CHANGED,script.getCurrentChatId());}
                (await import('/scripts/utils.js')).cancelDebounce(script.saveSettingsDebounced);
                const a=document.querySelector('#send_textarea');a.value=o.draft;a.dispatchEvent(new Event('input',{bubbles:true}));return{draftRestored:a.value===o.draft,helperGlobalRemoved:typeof window.TavernHelper==='undefined',helperUiRemoved:!document.querySelector('#tavern_helper'),helperFramesRemoved:!document.querySelector('iframe[id^="TH-"]')};},originalPageState);
            assert.ok(Object.values(report.cleanup.afterReload).every(Boolean),'QA_RELOAD_CLEANUP_INCOMPLETE');
        }catch(error){report.cleanup.errors.push(`QA_RELOAD_RESTORE:${error.message}`);}
    }
    if(base&&beforeSettingsHash){try{report.cleanup.persistedSettingsByteExact=createHash('sha256').update((await api('/api/settings/get',{})).settings).digest('hex')===beforeSettingsHash;if(!report.cleanup.persistedSettingsByteExact)report.cleanup.errors.push('QA_SETTINGS_CHANGED');}catch{report.cleanup.errors.push('QA_SETTINGS_VERIFY_FAILED');}}
    originalPageState=undefined;
    if(socket?.readyState===WebSocket.OPEN)socket.close();for(const request of pending.values())request.reject(new Error('QA_FINISHED'));pending.clear();
    removeForwards();process.removeListener('SIGINT',signalHandler);process.removeListener('SIGTERM',signalHandler);
    if(report.cleanup.errors.length){report.completed=false;process.exitCode=1;}report.finishedAt=new Date().toISOString();
    if(reportPath)await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({completed:report.completed,fixture,reportPath,plugin:report.plugin,initialization:report.initialization,messageSrcdoc:report.messageSrcdoc,messageBlob:report.messageBlob,scriptIframe:report.scriptIframe,cleanup:report.cleanup,...(report.error?{error:report.error}:{})}));
}
