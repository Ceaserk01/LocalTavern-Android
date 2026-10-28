import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { patchUpstream } from '../runtime/patch-upstream.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(project, 'upstream/SillyTavern');
const gitCommand = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A real Git smart-HTTP transport. Only the test fixture uses desktop Git;
// every client operation under test executes the shipped JavaScript adapter.
async function serveGit(projectRoot) {
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
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
            if (started) { response.write(chunk); return; }
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
            response.write(headers.subarray(end + separator));
            headers = Buffer.alloc(0);
        });
        child.on('close', () => response.end());
        child.on('error', error => response.destroy(error));
        request.pipe(child.stdin);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/fixture.git`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Android git adapter runs extension clone/update/version/branches through real smart HTTP', async t => {
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
    gitCommand(source, 'branch', 'feature/mobile');
    gitCommand(temporary, 'clone', '--bare', source, bare);
    gitCommand(source, 'remote', 'add', 'origin', bare);
    const transport = await serveGit(temporary);
    t.after(() => transport.close());
    const clone = path.join(temporary, 'extension');
    await createGitClient({ backend: 'builtin' }).clone(transport.url, clone, { depth: 1 });
    const client = androidGit({ baseDir: clone });
    assert.equal(await client.checkIsRepo(CheckRepoActions.IS_REPO_ROOT), true);
    assert.equal(await client.revparse(['--is-shallow-repository']), 'true');
    assert.equal((await client.branch()).current, 'main');
    assert.equal((await client.getRemotes(true))[0].refs.fetch, transport.url);
    await client.fetch('origin');
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
    await client.fetch('origin');
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
