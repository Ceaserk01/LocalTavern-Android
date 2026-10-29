import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { patchUpstream } from '../runtime/patch-upstream.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(project, 'upstream/SillyTavern');
const gitCommand = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A real Git smart-HTTP transport. Only the test fixture uses desktop Git;
// every client operation under test executes the shipped JavaScript adapter.
async function serveGit(projectRoot) {
    const uploads = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const transfer = { request: '', responseBytes: 0 };
        if (request.method === 'POST') {
            uploads.push(transfer);
            request.on('data', chunk => { transfer.request += chunk.toString(); });
        }
        const write = chunk => { transfer.responseBytes += chunk.length; response.write(chunk); };
        const child = spawn('git', ['http-backend'], {
            env: { ...process.env, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] || '',
                CONTENT_LENGTH: request.headers['content-length'] || '',
                SERVER_PROTOCOL: 'HTTP/1.1', REMOTE_ADDR: '127.0.0.1',
                HTTP_GIT_PROTOCOL: request.headers['git-protocol'] || '' },
        });
        let headers = Buffer.alloc(0);
        let started = false;
        child.stdout.on('data', chunk => {
            if (started) { write(chunk); return; }
            headers = Buffer.concat([headers, chunk]);
            let end = headers.indexOf('\r\n\r\n');
            let separator = 4;
            if (end < 0) { end = headers.indexOf('\n\n'); separator = 2; }
            if (end < 0) return;
            for (const header of headers.subarray(0, end).toString().split(/\r?\n/)) {
                const colon = header.indexOf(':');
                const key = header.slice(0, colon);
                const value = header.slice(colon + 1).trim();
                if (key.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]);
                else response.setHeader(key, value);
            }
            started = true;
            write(headers.subarray(end + separator));
            headers = Buffer.alloc(0);
        });
        child.on('close', () => response.end());
        child.on('error', error => response.destroy(error));
        request.pipe(child.stdin);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/fixture.git`, uploads, close: () => new Promise(resolve => server.close(resolve)) };
}

async function prepareAdapter(t) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-android-git-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const stage = path.join(temporary, 'staged');
    await fs.mkdir(path.join(stage, 'src/git'), { recursive: true });
    await fs.mkdir(path.join(stage, 'src/endpoints'), { recursive: true });
    for (const file of ['src/git/client.js', 'src/endpoints/extensions.js', 'src/plugin-loader.js', 'plugins.js']) {
        await fs.copyFile(path.join(upstream, file), path.join(stage, file));
    }
    await fs.writeFile(path.join(stage, 'package.json'), '{"type":"module"}');
    await fs.symlink(path.join(upstream, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
    const patch = await patchUpstream(stage);
    assert.equal(patch.adapter, 'isomorphic-git');
    await assert.rejects(patchUpstream(stage), /Upstream changed/);
    const { default: androidGit, CheckRepoActions } = await import(pathToFileURL(path.join(stage, 'src/git/android-git.mjs')));
    const { createGitClient } = await import(pathToFileURL(path.join(stage, 'src/git/client.js')));
    return { temporary, androidGit, createGitClient, CheckRepoActions };
}

test('Android git adapter runs extension clone/update/version/branches through real smart HTTP', async t => {
    const { temporary, androidGit, createGitClient, CheckRepoActions } = await prepareAdapter(t);
    const source = path.join(temporary, 'author');
    const bare = path.join(temporary, 'fixture.git');
    await fs.mkdir(source);
    gitCommand(source, 'init', '--initial-branch=main');
    gitCommand(source, 'config', 'user.name', 'Fixture');
    gitCommand(source, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(source, 'manifest.json'), '{"display_name":"Fixture","version":"1.0"}');
    await fs.writeFile(path.join(source, 'index.js'), 'export const version = 1;\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'first extension');
    gitCommand(source, 'checkout', '-b', 'feature/mobile');
    // An unrelated branch has a large incompressible blob: normal update checks
    // must not download and index it merely because the remote advertises it.
    await fs.writeFile(path.join(source, 'unrelated.bin'), randomBytes(1024 * 1024));
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'unrelated branch payload');
    const unrelatedCommit = gitCommand(source, 'rev-parse', 'HEAD');
    gitCommand(source, 'checkout', 'main');
    gitCommand(temporary, 'clone', '--bare', source, bare);
    gitCommand(source, 'remote', 'add', 'origin', bare);
    const transport = await serveGit(temporary);
    t.after(() => transport.close());
    const clone = path.join(temporary, 'extension');
    await createGitClient({ backend: 'builtin' }).clone(transport.url, clone, { depth: 1 });
    const client = androidGit({ baseDir: clone, timeout: { block: 5000 } });
    assert.equal(await client.checkIsRepo(CheckRepoActions.IS_REPO_ROOT), true);
    assert.equal(await client.revparse(['--is-shallow-repository']), 'true');
    assert.equal((await client.branch()).current, 'main');
    assert.equal((await client.getRemotes(true))[0].refs.fetch, transport.url);
    const ordinaryStart = transport.uploads.length;
    await client.fetch('origin');
    const ordinaryFetch = transport.uploads.slice(ordinaryStart);
    assert.ok(ordinaryFetch.length);
    assert.ok(ordinaryFetch.every(item => !item.request.includes(`want ${unrelatedCommit}`)), 'Ordinary checks request only the current branch');
    assert.throws(() => gitCommand(clone, 'cat-file', '-e', unrelatedCommit), 'Unrelated branch object was not transferred');
    const ordinaryBytes = ordinaryFetch.reduce((total, item) => total + item.responseBytes, 0);
    const before = await client.revparse(['HEAD']);
    assert.equal((await client.log({ from: before, to: 'origin/main' })).total, 0);

    await fs.writeFile(path.join(source, 'index.js'), 'export const version = 2;\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'second extension');
    gitCommand(source, 'push', 'origin', 'main');
    await client.fetch('origin');
    assert.equal((await client.log({ from: before, to: 'origin/main' })).total, 1);
    await client.pull('origin', 'main');
    assert.equal(await fs.readFile(path.join(clone, 'index.js'), 'utf8'), 'export const version = 2;\n');
    assert.notEqual(await client.revparse(['HEAD']), before);
    assert.equal(await client.revparse(['--abbrev-ref', '@{u}']), 'origin/main');

    await client.fetch('origin', ['--unshallow']);
    assert.equal(await client.revparse(['--is-shallow-repository']), 'false');
    await client.remote(['set-branches', 'origin', '*']);
    const allStart = transport.uploads.length;
    await client.fetch('origin');
    const allFetch = transport.uploads.slice(allStart);
    assert.ok(allFetch.some(item => item.request.includes(`want ${unrelatedCommit}`)), 'Explicit branch listing still fetches all advertised branches');
    const allBytes = allFetch.reduce((total, item) => total + item.responseBytes, 0);
    assert.ok(allBytes > ordinaryBytes + 1024 * 1024);
    t.diagnostic(`Git pack traffic: ordinary check ${ordinaryBytes} bytes; explicit all-branches fetch ${allBytes} bytes for 1 MiB unrelated branch`);
    assert.ok((await client.branch(['-r', '--list', 'origin/*'])).all.includes('origin/feature/mobile'));
    await client.checkoutBranch('feature/mobile', 'origin/feature/mobile');
    assert.equal((await client.branchLocal()).current, 'feature/mobile');
    assert.equal(await client.revparse(['--abbrev-ref', '@{u}']), 'origin/feature/mobile');
    assert.equal(await fs.readFile(path.join(clone, 'index.js'), 'utf8'), 'export const version = 1;\n');
    await client.checkout('main');
    assert.equal(await fs.readFile(path.join(clone, 'index.js'), 'utf8'), 'export const version = 2;\n');
    assert.equal(await androidGit(bare).checkIsRepo(), false);
    assert.equal(await androidGit(temporary).checkIsRepo(), false);
    await assert.rejects(client.fetch('origin', ['--unsupported']), /Unsupported fetch option/);

    // A new remote revision cannot silently overwrite a user's local edits.
    await fs.writeFile(path.join(clone, 'index.js'), 'user local changes\n');
    await fs.writeFile(path.join(source, 'index.js'), 'export const version = 3;\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'third extension');
    gitCommand(source, 'push', 'origin', 'main');
    await assert.rejects(client.pull('origin', 'main'));
    assert.equal(await fs.readFile(path.join(clone, 'index.js'), 'utf8'), 'user local changes\n');
});

// Forward a real smart-HTTP repository while controlling only transport timing.
async function proxyGit(t, target, mode) {
    const stalled = [];
    const origin = new URL(target).origin;
    const server = http.createServer(async (request, response) => {
        try {
            if (mode === 'headers' || (mode === 'body' && request.method === 'POST')) {
                const transfer = { socket: response.socket, closed: false };
                stalled.push(transfer);
                transfer.socket.once('close', () => { transfer.closed = true; });
                request.resume();
                if (mode === 'body') {
                    response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
                    response.write('0008NAK\n'); // Valid pack-response prefix, followed by a silent peer.
                }
                return;
            }
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const result = await fetch(origin + request.url, {
                method: request.method,
                headers: request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {},
                ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
            });
            const body = Buffer.from(await result.arrayBuffer());
            response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type'), 'Content-Length': body.length });
            if (mode === 'active') {
                // Total transfer takes much longer than block timeout; continued
                // network activity must keep it alive rather than hit a wall timer.
                const size = Math.ceil(body.length / 8);
                for (let offset = 0; offset < body.length; offset += size) {
                    if (offset) await delay(35);
                    if (response.destroyed) return;
                    response.write(body.subarray(offset, offset + size));
                }
                response.end();
            } else response.end(body);
        } catch (error) { response.destroy(error); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    return { url: `http://127.0.0.1:${server.address().port}/fixture.git`, stalled };
}

async function timeoutFixture(t) {
    const { temporary, androidGit, createGitClient } = await prepareAdapter(t);
    const source = path.join(temporary, 'author');
    await fs.mkdir(source);
    gitCommand(source, 'init', '--initial-branch=main');
    gitCommand(source, 'config', 'user.name', 'Fixture');
    gitCommand(source, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(source, 'index.js'), 'export const fixture = true;\n');
    gitCommand(source, 'add', '.');
    gitCommand(source, 'commit', '-m', 'timeout fixture');
    gitCommand(temporary, 'clone', '--bare', source, path.join(temporary, 'fixture.git'));
    const transport = await serveGit(temporary);
    t.after(() => transport.close());
    const clone = path.join(temporary, 'extension');
    await createGitClient({ backend: 'builtin' }).clone(transport.url, clone, { depth: 1 });
    return { androidGit, clone, transport };
}

test('configured Git block timeout aborts silent headers and pack bodies for fetch/pull', { timeout: 10000 }, async t => {
    const { androidGit, clone, transport } = await timeoutFixture(t);
    const before = gitCommand(clone, 'rev-parse', 'HEAD');
    const client = androidGit({ baseDir: clone, timeout: { block: 120 } });
    for (const [mode, operation] of [['headers', 'fetch'], ['body', 'fetch'], ['body', 'pull']]) {
        const proxy = await proxyGit(t, transport.url, mode);
        gitCommand(clone, 'config', 'remote.origin.url', proxy.url);
        const start = performance.now();
        await assert.rejects(client[operation]('origin', ...(operation === 'pull' ? ['main'] : [])), /Git block timeout reached/);
        const elapsed = performance.now() - start;
        assert.ok(elapsed < 2000, `Silent ${mode} ${operation} cancelled promptly: ${elapsed}ms`);
        for (let attempt = 0; attempt < 100 && !proxy.stalled.every(item => item.closed); attempt++) await delay(10);
        assert.equal(proxy.stalled.length, 1);
        assert.equal(proxy.stalled[0].closed, true, 'Timed-out network socket closes at the peer');
        assert.equal(proxy.stalled[0].socket.destroyed, true);
        assert.equal(gitCommand(clone, 'rev-parse', 'HEAD'), before);
        assert.equal(gitCommand(clone, 'status', '--porcelain'), '');
        t.diagnostic(`${operation} ${mode} stall rejected after ${Math.round(elapsed)}ms and closed its socket`);
    }
    gitCommand(clone, 'config', 'remote.origin.url', transport.url);
    await client.fetch('origin');
    await client.pull('origin', 'main'); // A prior cancellation cannot poison later operations.
    assert.equal(gitCommand(clone, 'rev-parse', 'HEAD'), before);
});

test('configured Git block timeout allows a slow transfer that keeps delivering data', { timeout: 10000 }, async t => {
    const { androidGit, clone, transport } = await timeoutFixture(t);
    const proxy = await proxyGit(t, transport.url, 'active');
    gitCommand(clone, 'config', 'remote.origin.url', proxy.url);
    const start = performance.now();
    await androidGit({ baseDir: clone, timeout: { block: 120 } }).fetch('origin');
    const elapsed = performance.now() - start;
    assert.ok(elapsed > 240, 'Total duration exceeds the timeout while active chunks extend the idle deadline');
    assert.equal(gitCommand(clone, 'status', '--porcelain'), '');
    t.diagnostic(`Active Git transfer completed after ${Math.round(elapsed)}ms with a 120ms inactivity timeout`);
});
