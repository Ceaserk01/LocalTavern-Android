// Exercise additional real bundled-server workflows. No paid API, global settings
// writes, or existing user files are needed. Each run uses its own random names.
// Host: node scripts/smoke_features.mjs
// Android: TAVERN_TEST_URL=http://127.0.0.1:18768 node scripts/smoke_features.mjs
// Optional sprites on a disposable external target: TAVERN_TEST_SPRITES=1.
// The upstream sprite API cannot remove its empty directory; this opt-in reports
// that exact residual path for the target's owner to remove after verification.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.env.TAVERN_TEST_URL;
const base = external || 'http://127.0.0.1:18771';
const fixtureId = `lt-features-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
const cache = path.join(project, '.cache');
await fs.mkdir(cache, { recursive: true });
const reportFile = process.env.TAVERN_TEST_REPORT || path.join(cache, `${fixtureId}.json`);
const temporary = !external ? await fs.mkdtemp(path.join(cache, 'features-')) : null;
const runSprites = !external || process.env.TAVERN_TEST_SPRITES === '1';
const started = performance.now();
const interruption = new AbortController();
const onInterrupt = () => interruption.abort(new Error('Interrupted by SIGINT'));
const onTerminate = () => interruption.abort(new Error('Interrupted by SIGTERM'));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
const cleanupTasks = [];
const cleanupErrors = [];
const cookies = new Map();
const checks = [];
let csrf;
let child;
let childExit;
let serverLogs = '';
let failure;
let requestCount = 0;
let ready = false;
let spriteDirectory;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function ownName(name) { assert.ok(name.startsWith(fixtureId), 'Cleanup is restricted to this run\'s names'); return name; }
function cleanup(label, action) { cleanupTasks.push({ label, action }); }
function imageSize(buffer) {
    assert.ok(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature');
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}
async function request(endpoint, body, { allow = [], cleanupRequest = false } = {}) {
    requestCount++;
    const multipart = body instanceof FormData;
    const headers = {};
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
    const signal = cleanupRequest ? AbortSignal.timeout(10000)
        : AbortSignal.any([interruption.signal, AbortSignal.timeout(30000)]);
    const response = await fetch(new URL(endpoint, `${base}/`), {
        method: body === undefined ? 'GET' : 'POST', headers, signal,
        body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const separator = pair.indexOf('=');
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(response.ok || allow.includes(response.status), `${endpoint}: HTTP ${response.status}: ${bytes.toString('utf8').slice(0, 160)}`);
    return { bytes, status: response.status, json: () => JSON.parse(bytes.toString('utf8')) };
}
const json = async (endpoint, body, options) => (await request(endpoint, body, options)).json();
const cleanupRequest = (endpoint, body, allow = []) => request(endpoint, body, { allow, cleanupRequest: true });

async function startHost() {
    // Do not accidentally run against a different server already using this port.
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(18771, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const stage = path.join(project, '.cache/bundle');
    const server = path.join(temporary, 'server');
    // android-entry changes links inside its server root. A private clone keeps
    // concurrent builds and smoke suites' prepared bundle entirely untouched.
    await fs.cp(stage, server, {
        recursive: true, mode: fsConstants.COPYFILE_FICLONE, verbatimSymlinks: true,
        filter: file => !['plugins', 'public/scripts/extensions/third-party'].includes(path.relative(stage, file)),
    });
    const plugin = path.join(temporary, 'plugins/feature-identity');
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, 'index.mjs'), `export const info={id:'local-tavern-feature-qa',name:'Feature QA identity',description:'Disposable isolated test'};export async function init(router){router.get('/identity',(_req,res)=>res.json({fixtureId:${JSON.stringify(fixtureId)}}));}\n`);
    child = spawn(process.execPath, [path.join(server, 'android-entry.mjs'), '--dataRoot', path.join(temporary, 'userdata'), '--port', '18771'], {
        cwd: server, stdio: ['ignore', 'pipe', 'pipe'],
    });
    childExit = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => { failure = error; });
    const capture = chunk => { serverLogs = (serverLogs + chunk).slice(-256 * 1024); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
}

async function waitReady() {
    const deadline = performance.now() + 60000;
    for (;;) {
        if (interruption.signal.aborted) throw interruption.signal.reason;
        if (failure || (child && child.exitCode !== null)) throw failure || new Error(`Isolated server exited: ${child.exitCode}`);
        try {
            csrf = (await json('/csrf-token')).token;
            assert.equal(typeof csrf, 'string');
            if (!external) assert.equal((await json('/api/plugins/local-tavern-feature-qa/identity')).fixtureId, fixtureId);
            ready = true; return;
        } catch (error) {
            if (performance.now() > deadline) throw error;
            await delay(200);
        }
    }
}

try {
    if (!external) await startHost();
    await waitReady();
    const originalSettings = (await json('/api/settings/get', {})).settings;
    const defaultImage = (await request('/img/ai4.png')).bytes;
    imageSize(defaultImage);

    // Non-UTF8 bytes, NUL, Unicode and newlines cross the real base64 upload and
    // authenticated static-file routes, then become an attachment in group data.
    const attachmentName = `${fixtureId}-attachment.txt`;
    const attachmentPath = `/user/files/${attachmentName}`;
    const attachment = Buffer.concat([Buffer.from('附件\nUnicode 🧪\n'), Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256))]);
    cleanup('attachment file', async () => {
        await cleanupRequest('/api/files/delete', { path: attachmentPath }, [404]);
        const verified = (await cleanupRequest('/api/files/verify', { urls: [attachmentPath] })).json();
        assert.equal(verified[attachmentPath], false);
        assert.equal((await request(attachmentPath, undefined, { allow: [404], cleanupRequest: true })).status, 404);
    });
    assert.equal((await json('/api/files/upload', { name: ownName(attachmentName), data: attachment.toString('base64') })).path, attachmentPath);
    assert.equal((await json('/api/files/verify', { urls: [attachmentPath] }))[attachmentPath], true);
    assert.ok((await request(attachmentPath)).bytes.equals(attachment));
    checks.push({ feature: 'binary file attachment upload, verification and authenticated download', bytes: attachment.length, sha256: sha256(attachment) });

    const avatars = [];
    for (const suffix of ['A', 'B']) {
        const name = `${fixtureId}-${suffix}`;
        const predictedAvatar = `${name}.png`;
        let avatar = predictedAvatar;
        cleanup(`character ${suffix}`, async () => {
            assert.ok(avatar.startsWith(fixtureId));
            await cleanupRequest('/api/characters/delete', { avatar_url: avatar, delete_chats: true }, [400]);
            const characters = (await cleanupRequest('/api/characters/all', {})).json();
            assert.ok(!characters.some(card => card.avatar === avatar));
        });
        const form = new FormData();
        form.append('avatar', new Blob([JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
            name, description: `群聊成员 ${suffix}`, personality: '友好', scenario: '海边测试', first_mes: '你好', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['QA'], creator: '', character_version: '1', extensions: {},
        } })], { type: 'application/json' }), `${name}.json`);
        form.append('file_type', 'json');
        const imported = await json('/api/characters/import', form);
        assert.ok(imported.file_name && !imported.error);
        avatar = imported.file_name.endsWith('.png') ? imported.file_name : `${imported.file_name}.png`;
        assert.equal(avatar, predictedAvatar, 'Unique character retains its expected file name');
        avatars.push(avatar);
    }

    const chatId = `${fixtureId}-group-chat`;
    const renamedChatId = `${chatId}-renamed`;
    const groupName = `${fixtureId}-群聊`;
    let group;
    cleanup('group metadata, chats and their backups', async () => {
        const groups = (await cleanupRequest('/api/groups/all', {})).json();
        for (const entry of groups.filter(item => item.name === groupName || item.name === `${groupName}-edited`)) {
            await cleanupRequest('/api/groups/delete', { id: entry.id });
        }
        for (const id of [chatId, renamedChatId]) {
            await cleanupRequest('/api/chats/group/delete', { id }, [400]);
            assert.deepEqual((await cleanupRequest('/api/chats/group/get', { id })).json(), []);
        }
        const backupPrefix = `chat_${chatId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_`;
        const backups = (await cleanupRequest('/api/backups/chat/get', {})).json();
        for (const backup of backups.filter(item => item.file_name.startsWith(backupPrefix))) {
            await cleanupRequest('/api/backups/chat/delete', { name: backup.file_name });
        }
        assert.ok(!(await cleanupRequest('/api/groups/all', {})).json().some(item => item.name.startsWith(fixtureId)));
        assert.ok(!(await cleanupRequest('/api/backups/chat/get', {})).json().some(item => item.file_name.startsWith(backupPrefix)));
    });
    group = await json('/api/groups/create', { name: ownName(groupName), members: avatars, disabled_members: [avatars[1]],
        chat_id: chatId, chats: [chatId], allow_self_responses: true, activation_strategy: 1, generation_mode: 0, auto_mode_delay: 7 });
    assert.deepEqual(group.members, avatars);
    assert.deepEqual(group.disabled_members, [avatars[1]]);
    const chat = [
        { user_name: 'QA User', character_name: groupName, chat_metadata: { integrity: fixtureId, note: '群聊元数据', attachments: [{ url: attachmentPath, name: attachmentName, size: attachment.length }] } },
        { name: 'QA User', is_user: true, send_date: '2026-10-29T00:00:00.000Z', mes: '海边\nUnicode 🧪' },
        { name: `${fixtureId}-A`, is_user: false, send_date: '2026-10-29T00:00:01.000Z', mes: '你好，备选回复', swipe_id: 1, swipes: ['原回复', '你好，备选回复'], extra: { display_text: '显示的回复', reason: '测试元数据' } },
        { name: 'System', is_system: true, send_date: '2026-10-29T00:00:02.000Z', mes: 'HIDDEN_FEATURE_QA' },
    ];
    // Save only once, so no trailing throttled backup can recreate data after cleanup.
    assert.equal((await json('/api/chats/group/save', { id: chatId, chat, force: true })).ok, true);
    assert.deepEqual(await json('/api/chats/group/get', { id: chatId }), chat);
    const groupInfo = await json('/api/chats/group/info', { id: chatId });
    assert.equal(groupInfo.chat_items, 3);
    const search = await json('/api/chats/search', { group_id: group.id, query: '海边 你好' });
    assert.equal(search.find(item => item.file_name === chatId)?.message_count, 3);
    const recent = await json('/api/chats/recent', { max: 10, metadata: true });
    assert.deepEqual(recent.find(item => item.group === group.id && item.file_id === chatId)?.chat_metadata, chat[0].chat_metadata);
    const exported = await json('/api/chats/export', { is_group: true, file: `${chatId}.jsonl`, format: 'jsonl', exportfilename: `${chatId}.jsonl` });
    assert.deepEqual(exported.result.split('\n').filter(Boolean).map(line => JSON.parse(line)), chat);
    const textExport = await json('/api/chats/export', { is_group: true, file: `${chatId}.jsonl`, format: 'txt', exportfilename: `${chatId}.txt` });
    assert.match(textExport.result, /QA User: 海边\nUnicode 🧪/);
    assert.match(textExport.result, /显示的回复/);
    assert.ok(!textExport.result.includes('HIDDEN_FEATURE_QA'));
    assert.equal((await json('/api/chats/rename', { is_group: true, original_file: `${chatId}.jsonl`, renamed_file: `${renamedChatId}.jsonl` })).sanitizedFileName, renamedChatId);
    assert.deepEqual(await json('/api/chats/group/get', { id: renamedChatId }), chat);
    assert.deepEqual(await json('/api/chats/group/get', { id: chatId }), []);
    group = { ...group, name: `${groupName}-edited`, chat_id: renamedChatId, chats: [renamedChatId], disabled_members: [] };
    assert.equal((await json('/api/groups/edit', group)).ok, true);
    const foundGroup = (await json('/api/groups/all', {})).find(item => item.id === group.id);
    for (const field of ['name', 'members', 'disabled_members', 'chat_id', 'chats', 'allow_self_responses', 'activation_strategy', 'auto_mode_delay']) assert.deepEqual(foundGroup[field], group[field]);
    checks.push({ feature: 'two-member group create/edit; group chat metadata, swipes, attachment, search, recents, JSONL/text export and rename', messages: 3 });

    const presetFamilies = [
        ['kobold', 'koboldai_setting_names', 'koboldai_settings'],
        ['novel', 'novelai_setting_names', 'novelai_settings'],
        ['openai', 'openai_setting_names', 'openai_settings'],
        ['textgenerationwebui', 'textgenerationwebui_preset_names', 'textgenerationwebui_presets'],
        ['instruct'], ['context'], ['sysprompt'], ['reasoning'],
    ];
    const presets = [];
    for (const [apiId] of presetFamilies) {
        const name = ownName(`${fixtureId}-${apiId}`);
        const preset = { name, temperature: 0.67, top_p: 0.91, content: '中文提示词\n{{char}} 与 {{user}}',
            story_string: '{{system}}\n{{description}}', input_sequence: 'USER:', output_sequence: 'ASSISTANT:',
            prefix: '<think>', suffix: '</think>', trim_strings: false, prompts: [{ identifier: 'main', role: 'system', content: '保留嵌套提示词' }] };
        cleanup(`preset ${apiId}`, () => cleanupRequest('/api/presets/delete', { apiId, name }, [404]));
        assert.equal((await json('/api/presets/save', { apiId, name, preset })).name, name);
        presets.push({ apiId, name, preset });
    }
    const settings = await json('/api/settings/get', {});
    for (const [apiId, nameKey, valuesKey] of presetFamilies) {
        const expected = presets.find(item => item.apiId === apiId);
        const actual = nameKey ? JSON.parse(settings[valuesKey][settings[nameKey].indexOf(expected.name)])
            : settings[apiId].find(item => item.name === expected.name);
        assert.deepEqual(actual, expected.preset);
    }
    checks.push({ feature: 'all eight preset families preserve Unicode, macros, nested prompts and numeric settings through discovery', apiIds: presetFamilies.map(([apiId]) => apiId) });

    const reply = { version: 2, name: ownName(`${fixtureId}-quickreply`), disableSend: true, placeBeforeInput: true, injectInput: true,
        color: '#123456', onlyBorderColor: true, qrList: [{ id: 1, label: '你好', message: '你好，{{char}}！\n第二行', preventAutoExecute: true, isHidden: false, contextList: [] }], idIndex: 1 };
    const theme = { name: ownName(`${fixtureId}-theme`), blur_strength: 12, blur_tint_color: 'rgba(12, 34, 56, 0.5)', main_text_color: '#eef2ff', chat_display: 1, font_scale: 1.05 };
    cleanup('quick-reply preset', () => cleanupRequest('/api/quick-replies/delete', { name: reply.name }));
    cleanup('theme preset', () => cleanupRequest('/api/themes/delete', { name: theme.name }, [404]));
    await request('/api/quick-replies/save', reply);
    await request('/api/themes/save', theme);
    const discovered = await json('/api/settings/get', {});
    assert.deepEqual(discovered.quickReplyPresets.find(item => item.name === reply.name), reply);
    assert.deepEqual(discovered.themes.find(item => item.name === theme.name), theme);
    checks.push({ feature: 'quick-reply and theme save/discovery preserve complete preset values' });

    const persona = ownName(`${fixtureId}-persona.png`);
    cleanup('persona avatar', async () => {
        await cleanupRequest('/api/avatars/delete', { avatar: persona }, [404]);
        assert.ok(!(await cleanupRequest('/api/avatars/get', {})).json().includes(persona));
    });
    const avatarForm = new FormData();
    avatarForm.append('avatar', new Blob([defaultImage], { type: 'image/png' }), persona);
    avatarForm.append('overwrite_name', persona);
    const crop = new URLSearchParams({ crop: JSON.stringify({ x: 0, y: 0, width: 1, height: 1, want_resize: false }) });
    assert.equal((await json(`/api/avatars/upload?${crop}`, avatarForm)).path, persona);
    assert.ok((await json('/api/avatars/get', {})).includes(persona));
    assert.deepEqual(imageSize((await request(`/User%20Avatars/${persona}`)).bytes), [1, 1]);
    checks.push({ feature: 'persona avatar multipart upload, real image crop, discovery and authenticated PNG serving', outputPixels: [1, 1] });

    if (runSprites) {
        const name = avatars[0].slice(0, -4);
        const label = 'joy';
        const spriteName = 'joy-qa';
        spriteDirectory = `characters/${name}`;
        cleanup('sprite image', async () => {
            await cleanupRequest('/api/sprites/delete', { name, label, spriteName }, [404]);
            assert.deepEqual((await request(`/api/sprites/get?${new URLSearchParams({ name })}`, undefined, { cleanupRequest: true })).json(), []);
        });
        const form = new FormData();
        form.append('avatar', new Blob([defaultImage], { type: 'image/png' }), `${spriteName}.png`);
        form.append('name', name); form.append('label', label); form.append('spriteName', spriteName);
        assert.equal((await json('/api/sprites/upload', form)).ok, true);
        const sprites = (await request(`/api/sprites/get?${new URLSearchParams({ name })}`)).json();
        assert.equal(sprites.length, 1);
        assert.equal(sprites[0].label, label);
        assert.ok(sprites[0].path.startsWith(`/characters/${name}/${spriteName}.png`));
        assert.ok((await request(sprites[0].path)).bytes.equals(defaultImage));
        checks.push({ feature: 'sprite multipart upload, discovery and byte-exact image serving', bytes: defaultImage.length, sha256: sha256(defaultImage) });
    }

    // This suite only creates uniquely named resources; settings.json is read,
    // never rewritten or restored over possible concurrent frontend changes.
    checks.push({ feature: 'global settings were not written', unchangedDuringRun: (await json('/api/settings/get', {})).settings === originalSettings });
} catch (error) {
    failure = error;
} finally {
    if (ready) {
        for (const task of cleanupTasks.reverse()) {
            try { await task.action(); }
            catch (error) { cleanupErrors.push({ resource: task.label, error: error.message }); }
        }
        try {
            const settings = (await cleanupRequest('/api/settings/get', {})).json();
            const names = [
                ...settings.koboldai_setting_names, ...settings.novelai_setting_names, ...settings.openai_setting_names,
                ...settings.textgenerationwebui_preset_names,
                ...['instruct', 'context', 'sysprompt', 'reasoning', 'quickReplyPresets', 'themes'].flatMap(key => settings[key].map(item => item.name)),
            ];
            assert.ok(!names.some(name => name.startsWith(fixtureId)), 'All uniquely named presets removed');
        } catch (error) { cleanupErrors.push({ resource: 'preset discovery after cleanup', error: error.message }); }
    }
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        const finished = await Promise.race([childExit.then(() => true), delay(5000).then(() => false)]);
        if (!finished) { child.kill('SIGKILL'); await childExit; }
    }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    if (!external) await fs.writeFile(path.join(cache, `${fixtureId}-server.log`), serverLogs);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
}

const report = {
    passed: !failure && cleanupErrors.length === 0,
    fixtureId, target: base, driverRuntime: process.version,
    serverMode: external ? 'external actual server; embedded runtime/version recorded separately' : 'private copy of actual prepared Android bundle',
    elapsedMs: Math.round(performance.now() - started), requestCount, checks,
    cleanup: { attempted: cleanupTasks.length, errors: cleanupErrors,
        residualEmptyDirectories: external && spriteDirectory ? [spriteDirectory] : [],
        ...(external && spriteDirectory ? { note: 'Explicit sprite opt-in: image files deleted; upstream has no API to remove its empty directory. Owner must remove this exact empty QA directory.' } : {}),
    },
    skipped: runSprites ? [] : ['sprites: enable TAVERN_TEST_SPRITES=1 only on a disposable target and remove the reported empty QA directory afterward'],
    ...(failure ? { failure: failure.message } : {}),
    scope: 'Backend persistence and file/image workflows; does not prove frontend interaction, group model generation, quick-reply execution, or every third-party plugin.',
};
await fs.mkdir(path.dirname(path.resolve(reportFile)), { recursive: true });
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, reportFile: path.resolve(reportFile) }, null, 2));
if (!report.passed) process.exitCode = 1;
