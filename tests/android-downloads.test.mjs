import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const hook = await fs.readFile(new URL('../runtime/android-downloads.js', import.meta.url), 'utf8');
const upstream = new URL('../upstream/SillyTavern/public/scripts/', import.meta.url);
const utils = await fs.readFile(new URL('utils.js', upstream), 'utf8');
const realDownload = utils.match(/export function download\([^]*?\n\}/)[0].replace('export ', '');
const promptManager = await fs.readFile(new URL('PromptManager.js', upstream), 'utf8');
const realPromptExport = promptManager.match(/    export\(data, type, name = 'export'\) \{[^]*?\n    \}/)[0];
const chats = await fs.readFile(new URL('chats.js', upstream), 'utf8');
const realAttachment = chats.match(/async function downloadAttachment\([^]*?\n\}/)[0];

function browser() {
    const listeners = new Map();
    const clicks = [];
    const popups = [];
    class Anchor {
        href = ''; download = '';
        click() { clicks.push(this); listeners.get('click')?.({ composedPath: () => [this] }); }
    }
    // Isolate the hooks from Node's URL implementation, preserving real revoke behavior.
    class BrowserURL extends URL {}
    BrowserURL.createObjectURL = URL.createObjectURL.bind(URL);
    BrowserURL.revokeObjectURL = URL.revokeObjectURL.bind(URL);
    const window = { open: (...args) => { popups.push(args); return {}; }, addEventListener: (name, callback) => listeners.set(name, callback) };
    const document = { createElement: name => { assert.equal(name, 'a'); return new Anchor(); }, addEventListener: (name, callback) => listeners.set(name, callback) };
    const context = vm.createContext({ window, document, HTMLAnchorElement: Anchor, URL: BrowserURL, Blob, console });
    vm.runInContext(hook, context);
    vm.runInContext(realDownload + '\nthis.download = download;', context);
    return { context, window, document, clicks, popups, URL: BrowserURL, api: window.__LOCAL_TAVERN_DOWNLOADS__,
        userClick: anchor => listeners.get('click')({ composedPath: () => [anchor] }),
        navigate: () => listeners.get('pagehide')() };
}

test('actual upstream utils.download preserves bytes and name after immediate revoke and delayed save', async () => {
    const page = browser();
    const content = JSON.stringify({ name: '角色卡', data: '内容'.repeat(180_000) });
    page.context.download(content, '角色卡导出.json', 'application/json');
    const url = page.clicks[0].href;
    await assert.rejects(fetch(url)); // The original URL really is revoked, immediately.
    await new Promise(resolve => setTimeout(resolve, 30)); // Native callback/picker is asynchronous.
    const retained = page.api.claim(url);
    assert.equal(retained.name, '角色卡导出.json');
    assert.equal(retained.blob.type, 'application/json');
    assert.equal(await retained.blob.text(), content);
    page.api.release(retained.id);
    assert.equal(page.api.claim(url), null);
});

test('actual PromptManager and attachment export callers retain their detached anchors', async () => {
    const page = browser();
    const manager = vm.runInContext('({' + realPromptExport + '})', page.context);
    manager.configuration = { version: 3 };
    manager.getFormattedDate = () => '20261029';
    manager.export({ prompts: ['你好'] }, 'full', '提示词');
    const prompt = page.api.claim(page.clicks[0].href);
    assert.equal(prompt.name, '提示词-20261029.json');
    assert.deepEqual(JSON.parse(await prompt.blob.text()), { version: 3, type: 'full', data: { prompts: ['你好'] } });
    page.api.release(prompt.id);
    vm.runInContext(realAttachment + '\nthis.downloadAttachment = downloadAttachment;', page.context);
    await page.context.downloadAttachment({ name: '附件.txt', text: '附件内容' });
    const attachment = page.api.claim(page.clicks[1].href);
    assert.equal(attachment.name, '附件.txt');
    assert.equal(await attachment.blob.text(), '附件内容');
    page.api.release(attachment.id);
});

test('attached user clicks, programmatic clicks, and blob popups do not require a Java bridge', async () => {
    const page = browser();
    const anchor = page.document.createElement('a');
    anchor.href = page.URL.createObjectURL(new Blob(['clicked'])); anchor.download = 'clicked.txt';
    page.userClick(anchor); page.URL.revokeObjectURL(anchor.href);
    const first = page.api.claim(anchor.href);
    assert.equal(await first.blob.text(), 'clicked'); page.api.release(first.id);
    page.context.download('second', 'second.txt', 'text/plain');
    const secondUrl = page.clicks[0].href;
    const second = page.api.claim(secondUrl); page.api.release(second.id);
    assert.equal(page.api.claim(secondUrl), null); // Capture listener did not pin twice.
    const popupUrl = page.URL.createObjectURL(new Blob(['popup']));
    page.window.open(popupUrl, '_blank'); page.URL.revokeObjectURL(popupUrl);
    assert.equal(await page.api.claim(popupUrl).blob.text(), 'popup');
    page.navigate(); assert.equal(page.api.claim(popupUrl), null);
});

test('ordinary blob revocation remains immediate and busy/cancel paths release retained files', async () => {
    const page = browser();
    const imageUrl = page.URL.createObjectURL(new Blob(['image']));
    page.URL.revokeObjectURL(imageUrl);
    await assert.rejects(fetch(imageUrl)); assert.equal(page.api.claim(imageUrl), null);
    page.context.download('first', 'first.txt', 'text/plain');
    const firstUrl = page.clicks[0].href;
    const first = page.api.claim(firstUrl);
    page.context.download('rejected', 'rejected.txt', 'text/plain');
    const rejectedUrl = page.clicks[1].href;
    page.api.discard(rejectedUrl);
    assert.equal(page.api.claim(rejectedUrl), null);
    assert.equal(await first.blob.text(), 'first'); // Busy rejection leaves claimed picker file alone.
    page.api.release(first.id); assert.equal(page.api.claim(firstUrl), null);
});

test('pending downloads are bounded and navigation releases claimed files', () => {
    const page = browser();
    for (let i = 0; i < 6; i++) page.context.download(String(i), `${i}.txt`, 'text/plain');
    assert.equal(page.api.claim(page.clicks[0].href), null);
    assert.equal(page.api.claim(page.clicks[1].href), null);
    const held = page.api.claim(page.clicks[2].href);
    for (let i = 6; i < 12; i++) page.context.download(String(i), `${i}.txt`, 'text/plain');
    assert.equal(held.blob.size, 1);
    page.navigate();
    for (const anchor of page.clicks) assert.equal(page.api.claim(anchor.href), null);
});

test('byte budget rejects oversized blobs without changing URL revocation behavior', async () => {
    const page = browser();
    class HugeBlob extends Blob { get size() { return 2 * 1024 * 1024 * 1024 + 1; } }
    const anchor = page.document.createElement('a');
    anchor.href = page.URL.createObjectURL(new HugeBlob(['small physical fixture']));
    anchor.click(); page.URL.revokeObjectURL(anchor.href);
    assert.equal(page.api.claim(anchor.href), null);
    await assert.rejects(fetch(anchor.href));
});
