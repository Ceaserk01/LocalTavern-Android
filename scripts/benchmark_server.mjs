// Representative backend workloads against the real packaged server. No paid model API.
// Android: adb forward tcp:18768 tcp:18766
// TAVERN_TEST_URL=http://127.0.0.1:18768 TAVERN_TEST_API_HOST=10.0.2.2 node scripts/benchmark_server.mjs
// Without TAVERN_TEST_URL, start an isolated host server using .cache/bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(project, '.cache'), { recursive: true });
const external = process.env.TAVERN_TEST_URL;
const adbSerial = process.env.TAVERN_BENCH_ADB_SERIAL;
const modelHost = adbSerial ? '127.0.0.1' : process.env.TAVERN_TEST_API_HOST || '127.0.0.1';
const cache = path.join(project, '.cache');
const temporary = external ? null : await fs.mkdtemp(path.join(cache, 'benchmark-'));
const runtime = path.join(project, '.cache/bundle');
const fixture = `ltbench_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ownedNames = new Set();
const ownedAvatars = new Set();
const priorAvatars = new Set();
const priorBackups = new Set();
const counts = { cards: 100, chatMessages: 5000, chatRounds: 5, discoveryRounds: 10,
    tokenizerRounds: 20, streamRounds: 5, streamEventsPerRound: 100, mockIntervalMs: 5, mockInitialDelayMs: 20 };
const started = performance.now();
const report = {
    schemaVersion: 1, completed: false, fixture, target: null,
    driver: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    scope: 'HTTP backend timings observed by the host driver, including response reads and client JSON parsing; not WebView rendering or real-device/model inference performance.',
    counts, measurements: {}, cleanup: { charactersDeleted: 0, backupsDeleted: 0, errors: [] },
    streamingTransport: { type: adbSerial ? 'adbReverse' : !external ? 'hostLoopback' : modelHost === '10.0.2.2' ? 'emulatorSlirp' : 'configuredModelHost',
        modelHost, ...(adbSerial ? { deviceSerial: adbSerial } : {}),
        note: 'Transport is part of the measurement. ADB reverse avoids the emulator SLIRP bridge; it does not simulate physical Wi-Fi or remote model latency.' },
};
let child, childExited, spawnError, serverLog = '', csrf, sessionReady = false, base, mock, ownedReverse;
const cookies = new Map();
const streamState = new Map();

function rounded(value) { return Math.round(value * 100) / 100; }
function summary(samples) {
    assert.ok(samples.length, 'A measurement needs real samples');
    const sorted = [...samples].sort((a, b) => a - b);
    const quantile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    return { samples: samples.length, minMs: rounded(sorted[0]), p50Ms: rounded(quantile(0.5)),
        p95Ms: rounded(quantile(0.95)), maxMs: rounded(sorted.at(-1)), totalMs: rounded(samples.reduce((a, b) => a + b, 0)) };
}
function requestHeaders(extra = {}) {
    return { Cookie: [...cookies].map(([key, val]) => `${key}=${val}`).join('; '),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
}
function captureCookies(response) {
    for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], split = pair.indexOf('=');
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
}
async function request(endpoint, body, { timeout = 30000 } = {}) {
    const begin = performance.now();
    const form = body instanceof FormData;
    const serialized = body === undefined || form ? body : JSON.stringify(body);
    const response = await fetch(`${base}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers: requestHeaders(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
        body: serialized, signal: AbortSignal.timeout(timeout),
    });
    captureCookies(response);
    const text = await response.text();
    assert.ok(response.ok, `${endpoint}: HTTP ${response.status}: ${text.slice(0, 300)}`);
    const value = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    return { value, text, elapsedMs: performance.now() - begin, responseBytes: Buffer.byteLength(text) };
}
async function ephemeralPort() {
    const reserve = http.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    return port;
}
async function startMock() {
    mock = http.createServer(async (request, response) => {
        try {
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.headers.authorization, 'Bearer benchmark-local-fixture');
            let text = '';
            for await (const chunk of request) text += chunk;
            const input = JSON.parse(text);
            const round = Number(input.messages[0].content.slice(`${fixture}:stream:`.length));
            assert.equal(input.messages[0].content, `${fixture}:stream:${round}`);
            assert.ok(Number.isInteger(round) && round >= 0 && round < counts.streamRounds);
            const state = { sentAt: [], lastSentAt: null };
            streamState.set(round, state);
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            response.flushHeaders();
            await delay(counts.mockInitialDelayMs);
            for (let index = 0; index < counts.streamEventsPerRound; index++) {
                state.sentAt.push(performance.now());
                response.write(`data: ${JSON.stringify({ id: `${fixture}-${round}-${index}`,
                    choices: [{ delta: { content: `增量回复-${index}` } }] })}\n\n`);
                if (index + 1 < counts.streamEventsPerRound) await delay(counts.mockIntervalMs);
            }
            state.lastSentAt = performance.now();
            response.end('data: [DONE]\n\n');
        } catch (error) {
            if (!response.headersSent) response.writeHead(500);
            response.end('Invalid local benchmark fixture request');
            process.stderr.write(`Mock fixture failed: ${error.message}\n`);
        }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    if (adbSerial) {
        let executable = process.env.TAVERN_BENCH_ADB_PATH;
        if (!executable) {
            const local = path.join(project, '.tooling/android/platform-tools/adb');
            executable = await fs.access(local).then(() => local, () => 'adb');
        }
        const local = `tcp:${mock.address().port}`;
        const mappings = execFileSync(executable, ['-s', adbSerial, 'reverse', '--list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
        assert.ok(!mappings.some(parts => parts.at(-2) === local), `Refusing to replace an existing ADB reverse mapping: ${local}`);
        // --no-rebind also closes the race between listing and binding the temporary port.
        execFileSync(executable, ['-s', adbSerial, 'reverse', '--no-rebind', local, local], { stdio: ['ignore', 'pipe', 'pipe'] });
        ownedReverse = { executable, serial: adbSerial, local, remote: local };
    }
    return `http://${modelHost}:${mock.address().port}/v1`;
}

function removeOwnedReverse() {
    if (!ownedReverse) return;
    const { executable, serial, local, remote } = ownedReverse;
    try {
        const mappings = execFileSync(executable, ['-s', serial, 'reverse', '--list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
        const current = mappings.find(parts => parts.at(-2) === local);
        if (!current) report.cleanup.reverseMappingRemoved = true;
        else if (current.at(-1) === remote) {
            execFileSync(executable, ['-s', serial, 'reverse', '--remove', local], { stdio: ['ignore', 'pipe', 'pipe'] });
            report.cleanup.reverseMappingRemoved = true;
        } else report.cleanup.errors.push(`ADB reverse mapping changed during benchmark; left untouched: ${local}`);
    } catch (error) { report.cleanup.errors.push(`Could not remove benchmark ADB reverse mapping: ${error.message}`); }
}

async function streamRound(round, modelUrl) {
    const begin = performance.now();
    const response = await fetch(`${base}/api/backends/chat-completions/generate`, {
        method: 'POST', headers: requestHeaders({ 'Content-Type': 'application/json' }),
        // A fake reverse-proxy password overrides any actual OpenAI secret on the target.
        body: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: modelUrl, proxy_password: 'benchmark-local-fixture',
            model: 'benchmark-model', messages: [{ role: 'user', content: `${fixture}:stream:${round}` }], stream: true, max_tokens: 256, temperature: 0 }),
        signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `Streaming API: HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let pending = '', received = 0, firstAt, done = false, responseBytes = 0;
    const forwardLag = [];
    function parseEvents() {
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { done = true; continue; }
            const event = JSON.parse(data);
            assert.equal(event.choices[0].delta.content, `增量回复-${received}`);
            const now = performance.now();
            firstAt ??= now;
            const emitted = streamState.get(round)?.sentAt[received];
            assert.equal(typeof emitted, 'number', 'SSE must originate in this local fixture');
            forwardLag.push(now - emitted);
            received++;
        }
    }
    for await (const chunk of response.body) {
        responseBytes += chunk.byteLength;
        pending += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
        parseEvents();
    }
    pending += decoder.decode(); parseEvents();
    assert.equal(received, counts.streamEventsPerRound, 'All incremental SSE events must be retained');
    assert.ok(done, 'SSE completion marker must be retained');
    assert.ok(firstAt < streamState.get(round).lastSentAt, 'SSE must be delivered incrementally before the model finishes');
    return { firstEventMs: firstAt - begin, totalMs: performance.now() - begin, forwardLag, responseBytes };
}

async function cleanupFixtures() {
    if (!sessionReady) return;
    try {
        const current = (await request('/api/characters/all', {}, { timeout: 5000 })).value;
        for (const card of current) if (ownedNames.has(card.name) && typeof card.avatar === 'string'
            && card.avatar.startsWith(`${fixture}_`) && !card.avatar.includes('/') && !card.avatar.includes('\\') && !priorAvatars.has(card.avatar)) {
            ownedAvatars.add(card.avatar);
        }
        const backupPrefixes = [...ownedAvatars].map(avatar => `chat_${avatar.replace(/\.png$/, '').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_`);
        const backups = (await request('/api/backups/chat/get', {}, { timeout: 5000 })).value;
        for (const backup of backups) {
            const name = backup.file_name;
            if (typeof name !== 'string' || priorBackups.has(name) || name.includes('/') || name.includes('\\')
                || !name.endsWith('.jsonl') || !backupPrefixes.some(prefix => name.startsWith(prefix))) continue;
            await request('/api/backups/chat/delete', { name }, { timeout: 5000 });
            report.cleanup.backupsDeleted++;
        }
        for (const avatar of ownedAvatars) {
            assert.ok(avatar.startsWith(`${fixture}_`) && !priorAvatars.has(avatar));
            await request('/api/characters/delete', { avatar_url: avatar, delete_chats: true }, { timeout: 5000 });
            report.cleanup.charactersDeleted++;
        }
    } catch (error) { report.cleanup.errors.push(error.message); }
}

try {
    assert.ok(!adbSerial || external, 'TAVERN_BENCH_ADB_SERIAL requires TAVERN_TEST_URL pointing to the Android server');
    if (external) base = new URL(external).origin;
    else {
        const port = await ephemeralPort();
        base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.join(runtime, 'android-entry.mjs'), '--dataRoot', path.join(temporary, 'userdata'), '--port', String(port)], { cwd: runtime });
        // Failed spawn emits error/close without exit; cleanup must never wait on a missing exit event.
        childExited = new Promise(resolve => child.once('close', resolve));
        child.on('error', error => { spawnError = error; serverLog += `${error.stack}\n`; });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverLog = `${serverLog}${chunk}`.slice(-128 * 1024); });
    }
    report.target = base;
    const readyBegin = performance.now();
    while (!sessionReady) {
        try { csrf = (await request('/csrf-token', undefined, { timeout: 1000 })).value.token; assert.ok(csrf); sessionReady = true; }
        catch (error) {
            if (spawnError || performance.now() - readyBegin > 60000 || (child && child.exitCode !== null)) throw new Error(`Target did not become ready: ${error.message}\n${serverLog}`);
            await delay(250);
        }
    }
    report.readinessWaitMs = rounded(performance.now() - readyBegin);
    report.readinessScope = external ? 'Availability polling only; the script did not start or time the Android app.' : 'Fresh private userdata and host Node process using the packaged source; excludes APK extraction and WebView.';
    const originalCards = (await request('/api/characters/all', {})).value;
    for (const card of originalCards) priorAvatars.add(card.avatar);
    for (const backup of (await request('/api/backups/chat/get', {})).value) priorBackups.add(backup.file_name);
    assert.ok(originalCards.every(card => !String(card.name).startsWith(fixture)), 'Fixture namespace must not exist before benchmark');
    report.baselineCharacterCount = originalCards.length;

    process.stderr.write(`Benchmark ${fixture}: importing ${counts.cards} real character cards…\n`);
    const imports = [], description = '这是一张用于性能测量的完整角色卡，包含人物描述、世界背景和对话约束。The original character-card API and real WASM image codec remain active.\n'.repeat(16);
    let cardJsonBytes = 0;
    for (let index = 0; index < counts.cards; index++) {
        const name = `${fixture}_${String(index).padStart(3, '0')}`;
        ownedNames.add(name);
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description,
            personality: '友好而谨慎。', scenario: '手机本地聊天性能测试。', first_mes: '你好，这是基准角色。', mes_example: '',
            creator_notes: 'Generated temporary benchmark fixture.', system_prompt: '', post_history_instructions: '',
            alternate_greetings: [], tags: ['benchmark-fixture'], creator: 'Local Tavern benchmark', character_version: '1.0', extensions: {} } };
        const json = JSON.stringify(card); cardJsonBytes += Buffer.byteLength(json);
        const form = new FormData();
        form.append('avatar', new Blob([json], { type: 'application/json' }), `${name}.json`);
        form.append('file_type', 'json'); form.append('preserved_name', `${name}.png`);
        const result = await request('/api/characters/import', form);
        const file = result.value.file_name;
        assert.ok(typeof file === 'string' && !result.value.error, 'Real card import must succeed');
        const avatar = file.endsWith('.png') ? file : `${file}.png`;
        assert.equal(avatar, `${name}.png`, 'Only uniquely named fixture cards may be created');
        assert.ok(!priorAvatars.has(avatar)); ownedAvatars.add(avatar);
        imports.push(result.elapsedMs);
    }
    report.measurements.characterImport = { ...summary(imports), cards: counts.cards, totalJsonBytes: cardJsonBytes,
        operation: 'Sequential JSON imports including actual PNG/WASM conversion, disk persistence and HTTP response' };

    const discovery = []; let discoveryBytes;
    for (let round = 0; round < counts.discoveryRounds; round++) {
        const result = await request('/api/characters/all', {});
        assert.equal(result.value.filter(card => ownedNames.has(card.name)).length, counts.cards);
        discovery.push(result.elapsedMs); discoveryBytes = result.responseBytes;
    }
    report.measurements.characterDiscovery = { ...summary(discovery), fixtureCards: counts.cards,
        totalCards: originalCards.length + counts.cards, responseBytes: discoveryBytes, fullCharacterMetadata: true };

    process.stderr.write(`Benchmark ${fixture}: ${counts.chatMessages} message chat save/load, tokenizer and SSE…\n`);
    const avatars = [...ownedAvatars], saves = [], loads = [];
    let chatRequestBytes, chatResponseBytes;
    for (let round = 0; round < counts.chatRounds; round++) {
        const avatar = avatars[round];
        const chat = [{ user_name: 'Benchmark User', character_name: avatar.replace(/\.png$/, ''), chat_metadata: { benchmarkFixture: fixture } }];
        const message = '离线酒馆性能样本：角色、世界书、流式回复；local API 0123456789。'.repeat(4);
        for (let index = 0; index < counts.chatMessages; index++) chat.push({ name: index % 2 ? 'Character' : 'Benchmark User',
            is_user: index % 2 === 0, is_system: false, send_date: '2026-01-01T00:00:00Z', mes: `${index}: ${message}` });
        const body = { avatar_url: avatar, file_name: `${fixture}_long_chat`, chat, force: true };
        chatRequestBytes = Buffer.byteLength(JSON.stringify(body));
        const saved = await request('/api/chats/save', body); assert.equal(saved.value.ok, true); saves.push(saved.elapsedMs);
        const loaded = await request('/api/chats/get', { avatar_url: avatar, file_name: body.file_name });
        assert.deepEqual(loaded.value, chat, 'All chat messages and Unicode content must round-trip intact');
        loads.push(loaded.elapsedMs); chatResponseBytes = loaded.responseBytes;
        // Each owned character is saved once: no trailing throttle callback can recreate a deleted benchmark backup.
    }
    report.measurements.longChatSave = { ...summary(saves), messagesPerChat: counts.chatMessages, requestBytes: chatRequestBytes };
    report.measurements.longChatLoad = { ...summary(loads), messagesPerChat: counts.chatMessages, responseBytes: chatResponseBytes };

    const tokenizerText = '中文角色卡和世界书。Token counting for streaming conversation.こんにちは。\n'.repeat(400);
    const first = await request('/api/tokenizers/openai/encode?model=gpt-4', { text: tokenizerText });
    assert.ok(first.value.ids.length > 0 && first.value.count > 0, 'Tokenizer must execute actual WASM');
    const encodes = [];
    for (let round = 0; round < counts.tokenizerRounds; round++) {
        const encoded = await request('/api/tokenizers/openai/encode?model=gpt-4', { text: tokenizerText });
        assert.deepEqual(encoded.value.ids, first.value.ids, 'Real tokenizer output must be stable'); encodes.push(encoded.elapsedMs);
    }
    const decoded = await request('/api/tokenizers/openai/decode?model=gpt-4', { ids: first.value.ids });
    assert.equal(decoded.value.text, tokenizerText);
    report.measurements.tokenizerEncode = { ...summary(encodes), firstEncodeMs: rounded(first.elapsedMs), inputUtf8Bytes: Buffer.byteLength(tokenizerText), tokenCount: first.value.ids.length,
        firstEncodeScope: 'First encode observed by this run; may already be initialized on an external target' };

    if (!external || process.env.TAVERN_TEST_API_HOST || adbSerial) {
        const modelUrl = await startMock(), firstEvents = [], completions = [], forwardLag = [];
        let streamBytes = 0;
        for (let round = 0; round < counts.streamRounds; round++) {
            const streamed = await streamRound(round, modelUrl);
            firstEvents.push(streamed.firstEventMs); completions.push(streamed.totalMs);
            forwardLag.push(...streamed.forwardLag); streamBytes += streamed.responseBytes;
        }
        report.measurements.streamingFirstEvent = { ...summary(firstEvents), mockInitialDelayMs: counts.mockInitialDelayMs };
        report.measurements.streamingForwardLag = { ...summary(forwardLag), eventsVerified: forwardLag.length, totalResponseBytes: streamBytes,
            measurement: 'Host mock write to host driver receive through the actual server proxy; same monotonic clock, no real model/network inference' };
        report.measurements.streamingCompletion = { ...summary(completions), mockIntervalMs: counts.mockIntervalMs, incrementalDeliveryVerified: true };
    } else report.measurements.streaming = { skipped: true, reason: 'Set TAVERN_TEST_API_HOST to a host address reachable from the external server to enable the local fixture.' };
    report.completed = true;
} catch (error) {
    report.error = error.message; process.exitCode = 1;
} finally {
    await cleanupFixtures();
    if (child && child.exitCode === null && !spawnError) {
        child.kill('SIGTERM');
        const timedOut = await Promise.race([childExited.then(() => false), delay(5000).then(() => true)]);
        if (timedOut) { child.kill('SIGKILL'); await childExited; }
    }
    removeOwnedReverse();
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    if (!external) await fs.writeFile(path.join(cache, 'benchmark-server.log'), serverLog);
    if (report.cleanup.errors.length) { report.completed = false; process.exitCode = 1; }
    report.totalDurationMs = rounded(performance.now() - started);
    console.log(JSON.stringify(report, null, 2));
}
