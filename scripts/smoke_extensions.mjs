// Run against an already running APK through `adb forward tcp:18768 tcp:18766`.
// For a desktop server: TAVERN_TEST_URL=http://127.0.0.1:18767 TAVERN_GIT_HOST=127.0.0.1
// Only the fixture server uses host Git; the APK executes its shipped JS Git adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(import.meta.dirname, '..');
const base = process.env.TAVERN_TEST_URL || 'http://127.0.0.1:18768';
const gitHost = process.env.TAVERN_GIT_HOST || '10.0.2.2';
const name = `android-git-smoke-${randomBytes(4).toString('hex')}`;
const temporary = await fs.mkdtemp(path.join(project, '.cache/extensions-smoke-'));
const source = path.join(temporary, 'author');
const bare = path.join(temporary, `${name}.git`);
const cookies = new Map();
const evidence = { passed: false, target: base, gitHost, fixture: name, checks: [], requests: [] };
const gitCommand = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
let csrf;
let installed = false;
let global = false;

async function request(endpoint, body, expected = 200) {
    const headers = { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body) headers['Content-Type'] = 'application/json';
    const start = performance.now();
    const response = await fetch(`${base}${endpoint}`, {
        method: body ? 'POST' : 'GET', headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
    });
    for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const separator = pair.indexOf('=');
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const text = await response.text();
    evidence.requests.push({ endpoint, status: response.status, elapsedMs: Math.round(performance.now() - start) });
    assert.equal(response.status, expected, `${endpoint}: ${response.status}: ${text.slice(0, 1000)}`);
    return { text, json: () => JSON.parse(text) };
}

const transport = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const child = spawn('git', ['http-backend'], {
        env: { ...process.env, GIT_PROJECT_ROOT: temporary, GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] || '',
            CONTENT_LENGTH: request.headers['content-length'] || '',
            SERVER_PROTOCOL: 'HTTP/1.1', REMOTE_ADDR: '127.0.0.1',
            HTTP_GIT_PROTOCOL: request.headers['git-protocol'] || '' },
    });
    let buffer = Buffer.alloc(0);
    let started = false;
    child.stdout.on('data', chunk => {
        if (started) { response.write(chunk); return; }
        buffer = Buffer.concat([buffer, chunk]);
        let end = buffer.indexOf('\r\n\r\n');
        let separator = 4;
        if (end < 0) { end = buffer.indexOf('\n\n'); separator = 2; }
        if (end < 0) return;
        for (const header of buffer.subarray(0, end).toString().split(/\r?\n/)) {
            const colon = header.indexOf(':');
            const key = header.slice(0, colon);
            const value = header.slice(colon + 1).trim();
            if (key.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]);
            else response.setHeader(key, value);
        }
        started = true;
        response.write(buffer.subarray(end + separator));
        buffer = Buffer.alloc(0);
    });
    child.on('close', code => {
        if (!started && code) response.statusCode = 500;
        response.end();
    });
    child.on('error', error => response.destroy(error));
    request.pipe(child.stdin);
});

try {
    // Startup is the only retried operation. Mutations must never be retried blindly.
    for (let attempt = 0; ; attempt++) {
        try { csrf = (await request('/csrf-token')).json().token; break; }
        catch (error) { if (attempt >= 120) throw error; await delay(500); }
    }
    assert.ok(csrf);
    await fs.mkdir(source);
    gitCommand(source, 'init', '--initial-branch=main');
    gitCommand(source, 'config', 'user.name', 'Android Fixture');
    gitCommand(source, 'config', 'user.email', 'fixture@example.invalid');
    const manifest = { display_name: 'Android Git smoke fixture', version: '1.0.0',
        author: 'local test', js: 'index.js', loading_order: 100, requires: [], optional: [] };
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(source, 'index.js'), 'export const fixtureVersion = "main-1";\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'fixture main1');
    const initialCommit = gitCommand(source, 'rev-parse', 'HEAD');
    gitCommand(source, 'checkout', '-b', 'feature/mobile');
    await fs.writeFile(path.join(source, 'index.js'), 'export const fixtureVersion = "feature";\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'fixture feature');
    const featureCommit = gitCommand(source, 'rev-parse', 'HEAD');
    gitCommand(source, 'checkout', 'main');
    gitCommand(temporary, 'clone', '--bare', source, bare);
    gitCommand(source, 'remote', 'add', 'origin', bare);
    await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
    const url = `http://${gitHost}:${transport.address().port}/${name}.git`;
    evidence.gitUrl = url;
    const extensionName = name;
    const install = (await request('/api/extensions/install', { url, global: false })).json();
    installed = true;
    assert.equal(install.folderName, name);
    assert.equal(install.version, '1.0.0');
    const discovered = (await request('/api/extensions/discover')).json();
    assert.ok(discovered.some(item => item.name === `third-party/${name}` && item.type === 'local'));
    assert.match((await request(`/scripts/extensions/third-party/${name}/index.js`)).text, /main-1/);
    evidence.checks.push('Git URL install; manifest discovery and executable JS served');

    const version = (await request('/api/extensions/version', { extensionName, global: false })).json();
    assert.equal(version.currentBranchName, 'main');
    assert.equal(version.currentCommitHash, initialCommit);
    assert.equal(version.isUpToDate, true);
    assert.equal(version.remoteUrl, url);
    evidence.checks.push('Version, branch, commit, remote and up-to-date status');

    await fs.writeFile(path.join(source, 'index.js'), 'export const fixtureVersion = "main-2";\n');
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'fixture main2');
    gitCommand(source, 'push', 'origin', 'main');
    const latestCommit = gitCommand(source, 'rev-parse', 'HEAD');
    assert.equal((await request('/api/extensions/version', { extensionName, global: false })).json().isUpToDate, false);
    const updated = (await request('/api/extensions/update', { extensionName, global: false })).json();
    assert.equal(updated.isUpToDate, false);
    assert.equal(updated.shortCommitHash, latestCommit.slice(0, 7));
    assert.match((await request(`/scripts/extensions/third-party/${name}/index.js`)).text, /main-2/);
    assert.equal((await request(`/scripts/extensions/third-party/${name}/manifest.json`)).json().version, '2.0.0');
    assert.equal((await request('/api/extensions/version', { extensionName, global: false })).json().isUpToDate, true);
    evidence.checks.push('Remote update fetched and checked out; manifest and JS both updated');

    const branches = (await request('/api/extensions/branches', { extensionName, global: false })).json();
    assert.ok(branches.some(branch => branch.name === 'origin/feature/mobile'));
    await request('/api/extensions/switch', { extensionName, global: false, branch: 'origin/feature/mobile' }, 204);
    const feature = (await request('/api/extensions/version', { extensionName, global: false })).json();
    assert.equal(feature.currentBranchName, 'feature/mobile');
    assert.equal(feature.currentCommitHash, featureCommit);
    assert.match((await request(`/scripts/extensions/third-party/${name}/index.js`)).text, /feature/);
    await request('/api/extensions/switch', { extensionName, global: false, branch: 'main' }, 204);
    assert.match((await request(`/scripts/extensions/third-party/${name}/index.js`)).text, /main-2/);
    evidence.checks.push('Unshallow and list all branches; switch slash-containing remote branch and back');

    await request('/api/extensions/move', { extensionName, source: 'local', destination: 'global' }, 204);
    global = true;
    assert.ok((await request('/api/extensions/discover')).json().some(item => item.name === `third-party/${name}` && item.type === 'global'));
    assert.equal((await request('/api/extensions/version', { extensionName, global: true })).json().currentCommitHash, latestCommit);
    assert.match((await request(`/scripts/extensions/third-party/${name}/index.js`)).text, /main-2/);
    await request('/api/extensions/move', { extensionName, source: 'global', destination: 'local' }, 204);
    global = false;
    evidence.checks.push('Move local/global extensions with Git metadata and serving preserved');

    await request('/api/extensions/delete', { extensionName, global: false });
    installed = false;
    assert.ok(!(await request('/api/extensions/discover')).json().some(item => item.name === `third-party/${name}`));
    await request(`/scripts/extensions/third-party/${name}/manifest.json`, undefined, 404);
    evidence.checks.push('Delete removes discovery entry and extension files');
    evidence.passed = true;
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    // Remove only this uniquely named test extension, leaving the user's server running.
    if (installed) {
        try { await request('/api/extensions/delete', { extensionName: name, global }); }
        catch (error) { evidence.cleanupError = String(error); }
    }
    transport.closeAllConnections();
    if (transport.listening) await new Promise(resolve => transport.close(resolve));
    await fs.writeFile(path.join(project, '.cache/smoke-extensions.json'), JSON.stringify(evidence, null, 2) + '\n');
    await fs.rm(temporary, { recursive: true, force: true });
}
