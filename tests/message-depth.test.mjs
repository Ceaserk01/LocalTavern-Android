import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { patchUpstream } from '../runtime/patch-upstream.mjs';

const upstream = new URL('../upstream/SillyTavern/', import.meta.url);
const originalSource = await fs.readFile(new URL('public/script.js', upstream), 'utf8');
const originalBlock = originalSource.match(/        const usableMessages = chat\.map\([^]*?        const depth = [^\n]+;/)?.[0];
assert.ok(originalBlock, 'Pinned upstream regex-depth calculation must exist');

// Execute the calculation extracted from the actual staged build, rather than
// maintaining a separate implementation in the test.
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tavern-depth-'));
let stagedSource, patches;
try {
    await fs.mkdir(path.join(stage, 'src/git'), { recursive: true });
    for (const file of ['src/endpoints/extensions.js', 'src/plugin-loader.js', 'plugins.js',
        'public/scripts/extensions/tts/system.js', 'public/script.js']) {
        await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
        await fs.copyFile(new URL(file, upstream), path.join(stage, file));
    }
    patches = await patchUpstream(stage);
    stagedSource = await fs.readFile(path.join(stage, 'public/script.js'), 'utf8');
} finally { await fs.rm(stage, { recursive: true, force: true }); }
const optimizedBlock = stagedSource.match(/        const numericMessageId = Number\(messageId\);[^]*?\n        \}/)?.[0];
assert.ok(optimizedBlock, 'Staged regex-depth optimization must exist');
const original = new Function('chat', 'messageId', `${originalBlock}\nreturn depth;`);
const optimized = new Function('chat', 'messageId', `${optimizedBlock}\nreturn depth;`);

test('staged depth patch is unique and leaves upstream and formatter stages intact', async () => {
    assert.equal(patches.changes.filter(change => change.file === 'public/script.js').length, 1);
    assert.equal(patches.changes.find(change => change.file === 'public/script.js').occurrences, 1);
    assert.equal(stagedSource.split(optimizedBlock).length - 1, 1);
    assert.equal(stagedSource.split(originalBlock).length - 1, 0);
    assert.equal(stagedSource.replace(optimizedBlock,
        originalBlock).replace('        // Regex depth counts later non-system messages. Scan only the tail\n        // instead of allocating a whole-chat index for every rendered message.\n', ''), originalSource,
    'Only the depth calculation changes: regex hooks, ordering and full message rendering stay byte-identical');
    assert.equal(await fs.readFile(new URL('public/script.js', upstream), 'utf8'), originalSource,
        'The actual upstream checkout is never edited');
});

test('depth preserves system-message filtering, sparse holes and coerced numeric IDs', () => {
    const sparse = new Array(9);
    sparse[0] = { mes: 'first' }; sparse[3] = { mes: 'hidden', is_system: true };
    sparse[5] = { mes: 'later', is_system: false }; sparse[8] = { mes: 'last' };
    const chats = [[], [{ mes: 'single' }], [{ mes: 'system', is_system: true }],
        [{ is_system: false }, { is_system: true }, {}, { is_system: true }, { is_system: false }], sparse];
    const ids = [-2, -1, -0, 0, 1, 2, 3, 4, 5, 8, 9, 100, 1.5, NaN, Infinity, -Infinity,
        '0', '2', '3', '5', '-1', '1.5', ' 5 ', '', 'not-a-number', null, undefined, false, true, 0n, 5n];
    for (const chat of chats) for (const id of ids) assert.equal(optimized(chat, id), original(chat, id));
    assert.equal(optimized(chats[3], 0), 2);
    assert.equal(optimized(chats[3], 1), undefined, 'System messages have no regex depth');
    assert.equal(optimized(sparse, 0), 2);
    assert.equal(optimized(sparse, 1), undefined, 'A sparse hole is not an existing message');
    assert.equal(optimized(sparse, '5'), 1);
    assert.equal(optimized(sparse, 8), 0);
});

test('deterministic mixed conversations match the actual original calculation', () => {
    let seed = 0x6a72e1;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let run = 0; run < 120; run++) {
        const chat = new Array(1 + Math.floor(random() * 70));
        for (let index = 0; index < chat.length; index++) {
            if (random() < 0.12) continue;
            chat[index] = { mes: `message ${index}`, is_system: random() < 0.3, is_user: index % 2 === 0 };
        }
        for (let index = -2; index <= chat.length + 2; index++) {
            assert.equal(optimized(chat, index), original(chat, index));
            assert.equal(optimized(chat, String(index)), original(chat, String(index)));
        }
    }
});

const regexSource = await fs.readFile(new URL('public/scripts/extensions/regex/engine.js', upstream), 'utf8');
function sourceFunction(name, exported = true) {
    const expression = new RegExp(`${exported ? 'export ' : ''}function ${name}\\([^]*?\\n\\}`);
    const source = regexSource.match(expression)?.[0];
    assert.ok(source, `Actual upstream ${name} must exist`);
    return source.replace(/^export /, '');
}
const regexContext = vm.createContext({
    console: { warn() {}, debug() {} }, extension_settings: { disabledExtensions: [] },
    substitute_find_regex: { NONE: 0, RAW: 1, ESCAPED: 2 },
    substituteParams: text => text, substituteParamsExtended: text => text,
    RegexProvider: { instance: { get: source => new RegExp(source, 'g') } },
});
vm.runInContext([
    sourceFunction('getRegexedString'), sourceFunction('runRegexScript'), sourceFunction('filterString', false),
].join('\n'), regexContext);

test('actual regex engine min/max depth ranges select identical replacements', () => {
    const scripts = [
        { scriptName: 'last', minDepth: 0, maxDepth: 0 },
        { scriptName: 'one-to-two', minDepth: 1, maxDepth: 2 },
        { scriptName: 'older', minDepth: 3, maxDepth: null },
        { scriptName: 'at-most-two', minDepth: null, maxDepth: 2 },
        { scriptName: 'unbounded', minDepth: -1, maxDepth: -1 },
    ].map(script => ({ ...script, placement: [1, 2, 6], markdownOnly: true, promptOnly: false,
        runOnEdit: true, substituteRegex: 0, findRegex: '^', replaceString: `[${script.scriptName}]$0`, trimStrings: [] }));
    regexContext.getRegexScripts = () => scripts;
    const chat = [{}, { is_system: true }, {}, {}, { is_system: true }, {}, {}];
    const render = (depth, placement = 2) => regexContext.getRegexedString('message', placement, { isMarkdown: true, depth });
    for (const id of [0, 1, 2, 3, 4, 5, 6, -1, 100, '0', '6', null, undefined]) {
        for (const placement of [1, 2, 6]) assert.equal(render(optimized(chat, id), placement), render(original(chat, id), placement));
    }
    assert.match(render(optimized(chat, 6)), /\[last\]/);
    assert.doesNotMatch(render(optimized(chat, 6)), /\[one-to-two\]|\[older\]/);
    assert.match(render(optimized(chat, 3)), /\[one-to-two\]/);
    assert.match(render(optimized(chat, 0)), /\[older\]/);
    assert.doesNotMatch(render(optimized(chat, 0)), /\[at-most-two\]|\[last\]/);
    for (const script of scripts) assert.ok(render(undefined).includes(`[${script.scriptName}]`),
        'Undefined depth retains upstream behavior of bypassing all min/max depth limits');
});

test('5000-message last-page depths avoid whole-chat allocations and reads', t => {
    function instrument() {
        const counts = { messageReads: 0, mappedEntries: 0, mapCalls: 0 };
        const chat = new Proxy(Array.from({ length: 5000 }, () => ({ is_system: false })), {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) counts.messageReads++;
                if (property === 'map') return function (callback) {
                    counts.mapCalls++;
                    return Array.prototype.map.call(this, (...args) => { counts.mappedEntries++; return callback(...args); });
                };
                return Reflect.get(target, property, receiver);
            },
        });
        return { chat, counts };
    }
    const before = instrument(), after = instrument(), expected = [], actual = [];
    for (let id = 4900; id < 5000; id++) { expected.push(original(before.chat, id)); actual.push(optimized(after.chat, id)); }
    assert.deepEqual(actual, expected);
    assert.equal(before.counts.mappedEntries, 500000, 'Original source allocates one index object for each mapped entry');
    assert.equal(before.counts.messageReads, 500000);
    assert.equal(after.counts.mapCalls, 0);
    assert.equal(after.counts.mappedEntries, 0);
    assert.equal(after.counts.messageReads, 5050, '100 target reads plus 4950 later-message reads');
    t.diagnostic(`For 100 displayed messages: original ${before.counts.messageReads} chat reads / ${before.counts.mappedEntries} index objects; optimized ${after.counts.messageReads} reads / 0 index objects. No wall-clock threshold is used.`);
});
