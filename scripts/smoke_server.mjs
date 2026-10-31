// Exercise the actual packaged server and WASM dependencies, without paid APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.env.TAVERN_TEST_URL;
const bundle = path.resolve(process.env.TAVERN_BUNDLE_ROOT || path.join(project, '.cache/bundle'));
const temporary = await fs.mkdtemp(path.join(project, '.cache/smoke-'));
const root = path.join(temporary, 'server');
const data = path.join(temporary, 'userdata');
const port = 18767;
const base = external || `http://127.0.0.1:${port}`;
let logs = '';
let child;
let childExit;
let start = performance.now();
let bundleCloneMs;
let mockRequests = 0;
const mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(input.messages[0].content, '你好');
    mockRequests++;
    if (input.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"本地"}}]}\n\n');
        await delay(20);
        res.end('data: {"choices":[{"delta":{"content":"成功"}}]}\n\ndata: [DONE]\n\n');
    } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '连接成功' } }] }));
    }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const runApi = !external || Boolean(process.env.TAVERN_TEST_API_HOST);
const mockUrl = `http://${process.env.TAVERN_TEST_API_HOST || '127.0.0.1'}:${mock.address().port}/v1`;
const cookies = new Map();
let csrf;
async function request(endpoint, body, opts = {}) {
    const headers = { Cookie: [...cookies].map(([key, val]) => `${key}=${val}`).join('; '), ...opts.headers };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${endpoint}`, {
        method: body ? 'POST' : 'GET', ...opts, headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
    });
    for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await response.text();
    assert.ok(response.ok, `${endpoint}: ${response.status}: ${text.slice(0, 500)}`);
    return { text, json: () => JSON.parse(text), response };
}
try {
    if (!external) {
        // android-entry rewrites these two runtime links. Copy the actual
        // bundle first so the prepared/extracted source stays reusable.
        // Preserve all other symlinks verbatim instead of following targets.
        const cloneStart = performance.now();
        await fs.cp(bundle, root, {
            recursive: true, dereference: false, verbatimSymlinks: true,
            mode: fsConstants.COPYFILE_FICLONE,
            filter: file => !['plugins', 'public/scripts/extensions/third-party'].includes(path.relative(bundle, file)),
        });
        bundleCloneMs = Math.round(performance.now() - cloneStart);
        const plugin = path.join(temporary, 'plugins/smoke');
        await fs.mkdir(plugin, { recursive: true });
        await fs.writeFile(path.join(plugin, 'index.mjs'), `import yaml from 'yaml';
export const info = {id:'android-smoke', name:'Android smoke', description:'Persistent plugin test'};
export async function init(router) {router.get('/ping', (_req,res)=>res.json(yaml.parse('ok: true')));}
`);
        for (const directory of ['default-user/extensions/smoke', 'global-extensions/smoke-global']) {
            await fs.mkdir(path.join(data, directory), { recursive: true });
            await fs.writeFile(path.join(data, directory, 'manifest.json'), JSON.stringify({ display_name: directory, loading_order: 100, requires: [], optional: [], js: '', css: '', author: 'smoke', version: '1.0.0', homePage: '' }));
        }
        start = performance.now();
        child = spawn(process.execPath, [path.join(root, 'android-entry.mjs'), '--dataRoot', data, '--port', String(port)], {
            cwd: root, env: { ...process.env, TAVERN_PLUGINS_DIR: path.join(temporary, 'plugins') },
        });
        childExit = new Promise(resolve => child.once('close', resolve));
        child.stdout.on('data', chunk => { logs += chunk; });
        child.stderr.on('data', chunk => { logs += chunk; });
    }
    for (let attempt = 0; ; attempt++) {
        try { csrf = (await request('/csrf-token')).json().token; break; }
        catch (error) {
            if (attempt > 300 || (child && child.exitCode !== null)) throw new Error(`${error}\n${logs}`);
            await delay(200);
        }
    }
    const startupMs = Math.round(performance.now() - start);
    assert.ok(csrf);
    assert.match((await request('/')).text, /SillyTavern/);
    assert.ok((await request('/lib.js')).text.length > 100000, 'Real frontend bundle must be served');
    const noCsrf = await fetch(`${base}/api/settings/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403, 'CSRF protection stays enabled');
    const settings = (await request('/api/settings/get', {})).json();
    assert.ok(settings.settings);
    if (!external) {
        assert.equal((await request('/api/plugins/android-smoke/ping')).json().ok, true);
        const extensions = (await request('/api/extensions/discover')).json();
        assert.ok(extensions.some(x => x.name.endsWith('/smoke')), 'User extension discovered');
        assert.ok(extensions.some(x => x.name.endsWith('/smoke-global')), 'Persistent global extension discovered');
    }

    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Android Smoke Test', description: '中文角色卡', personality: '友好', scenario: '测试', first_mes: '你好', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['test'], creator: '', character_version: '', extensions: {},
    } };
    const form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'android-test.json');
    form.append('file_type', 'json');
    const imported = (await request('/api/characters/import', form)).json();
    assert.ok(imported.file_name && !imported.error, 'JSON character imports into PNG with metadata');
    const avatar = imported.file_name.endsWith('.png') ? imported.file_name : `${imported.file_name}.png`;
    const readCard = (await request('/api/characters/get', { avatar_url: avatar })).json();
    assert.equal(readCard.data.description, '中文角色卡');
    const exported = await request('/api/characters/export', { avatar_url: avatar, format: 'png' });
    assert.equal(exported.response.headers.get('content-type'), 'image/png');

    const world = { entries: { 0: { uid: 0, key: ['安卓'], content: '世界书内容', constant: false, selective: true, order: 100 } } };
    await request('/api/worldinfo/edit', { name: 'Android Smoke Test', data: world });
    assert.deepEqual((await request('/api/worldinfo/get', { name: 'Android Smoke Test' })).json(), world);
    const chat = [{ user_name: 'You', character_name: 'Android Smoke Test', chat_metadata: {} },
        { name: 'You', is_user: true, send_date: '2026-01-01', mes: '本地保存测试' }];
    await request('/api/chats/save', { avatar_url: avatar, file_name: 'smoke-chat', chat, force: true });
    assert.deepEqual((await request('/api/chats/get', { avatar_url: avatar, file_name: 'smoke-chat' })).json(), chat);
    const encoded = (await request('/api/tokenizers/openai/encode?model=gpt-4', { text: '中文 tokenizer 正常工作' })).json();
    assert.ok(encoded.ids.length > 0, 'Real tiktoken WASM produces tokens');
    const decoded = (await request('/api/tokenizers/openai/decode?model=gpt-4', { ids: encoded.ids })).json();
    assert.equal(decoded.text, '中文 tokenizer 正常工作');
    if (runApi) {
        const completion = { chat_completion_source: 'custom', custom_url: mockUrl, model: 'test-model',
            messages: [{ role: 'user', content: '你好' }], stream: false, temperature: 0.7, max_tokens: 64 };
        const result = (await request('/api/backends/chat-completions/generate', completion)).json();
        assert.equal(result.choices[0].message.content, '连接成功');
        const stream = (await request('/api/backends/chat-completions/generate', { ...completion, stream: true })).text;
        assert.match(stream, /本地/); assert.match(stream, /成功/); assert.match(stream, /\[DONE\]/);
        assert.equal(mockRequests, 2);
    }
    console.log(JSON.stringify({ passed: true, startupMs, runtime: external ? 'embedded Node; version recorded in runtime.log' : process.version, driverRuntime: process.version, target: base,
        ...(!external ? { bundleSourceRoot: bundle, bundleCloneMs, serverMode: 'private copy of actual prepared/extracted Android bundle' } : {}),
        checks: ['frontend', 'csrf', 'settings', 'character import/export + WASM image codec', 'worldbook', 'chat persistence', 'tiktoken WASM roundtrip', ...(!external ? ['persistent server plugin + npm dependency', 'local/global extensions'] : []), ...(runApi ? ['OpenAI-compatible API', 'SSE streaming'] : [])] }, null, 2));
} finally {
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        const finished = await Promise.race([childExit.then(() => true), delay(5000, false, { ref: false })]);
        if (!finished) { child.kill('SIGKILL'); await childExit; }
    }
    mock.closeAllConnections(); mock.close();
    await fs.writeFile(path.join(project, '.cache/smoke-server.log'), logs);
    await fs.rm(temporary, { recursive: true, force: true });
}
