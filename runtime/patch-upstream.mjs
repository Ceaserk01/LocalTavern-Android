import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

/** Apply narrowly checked patches to a staged upstream tree, never the checkout. */
export async function patchUpstream(root) {
    const changes = [];
    async function replace(file, before, after, expected = 1) {
        const target = path.join(root, file);
        const source = await fs.readFile(target, 'utf8');
        const occurrences = source.split(before).length - 1;
        if (occurrences !== expected) {
            throw new Error(`Upstream changed: ${file}: expected ${expected} matching patch sites, found ${occurrences}`);
        }
        await fs.writeFile(target, source.replaceAll(before, after));
        changes.push({ file, occurrences });
    }
    await fs.copyFile(path.join(directory, 'android-git.mjs'), path.join(root, 'src/git/android-git.mjs'));
    await replace('src/endpoints/extensions.js',
        "import { CheckRepoActions, default as simpleGit } from 'simple-git';",
        "import { CheckRepoActions, default as simpleGit } from '../git/android-git.mjs';");
    await replace('src/endpoints/extensions.js',
        '        await git.clone(parsedUrl.href, extensionPath, cloneOptions);',
        `        try {
            await git.clone(parsedUrl.href, extensionPath, cloneOptions);
        } catch (error) {
            // Interrupted mobile downloads must remain retryable.
            await fs.promises.rm(extensionPath, { recursive: true, force: true });
            throw error;
        }`);
    await replace('src/plugin-loader.js',
        "import { default as git, CheckRepoActions } from 'simple-git';",
        "import { default as git, CheckRepoActions } from './git/android-git.mjs';");
    await replace('src/plugin-loader.js',
        "import { sync as commandExistsSync } from 'command-exists';\n", '');
    await replace('src/plugin-loader.js',
        "    if (!commandExistsSync('git')) {\n        console.error(color.red('Git is not installed. Please install Git to enable auto-updating of server plugins.'));\n        return;\n    }\n", '');
    await replace('plugins.js',
        "import { default as git, CheckRepoActions } from 'simple-git';",
        "import { default as git, CheckRepoActions } from './src/git/android-git.mjs';");
    await replace('public/scripts/extensions/tts/system.js',
        '    fetchTtsVoiceObjects() {',
        '    async fetchTtsVoiceObjects() {');
    await replace('public/scripts/extensions/tts/system.js',
        '        return new Promise((resolve) => {',
        `        if (speechSynthesis.__localTavernNative === true) {
            await speechSynthesis.__localTavernVoicesReady();
        }
        return new Promise((resolve) => {`);
    await replace('public/scripts/extensions/tts/system.js',
        '            speechUtteranceChunker(utterance, {',
        `            // Android's native engine handles its own input-size limit.
            // Keep one utterance so completion/error covers the complete text,
            // including long Chinese text without Western chunk delimiters.
            if (speechSynthesis.__localTavernNative === true) {
                speechSynthesis.speak(utterance);
                return;
            }
            speechUtteranceChunker(utterance, {`);
    await replace('public/script.js',
        `        const usableMessages = chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
        const indexOf = usableMessages.findIndex(x => x.index === Number(messageId));
        const depth = messageId >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;`,
        `        // Regex depth counts later non-system messages. Scan only the tail
        // instead of allocating a whole-chat index for every rendered message.
        const numericMessageId = Number(messageId);
        let depth;
        if (Number.isInteger(numericMessageId) && numericMessageId >= 0 && numericMessageId < chat.length
            && numericMessageId in chat && !chat[numericMessageId].is_system) {
            depth = 0;
            for (let index = numericMessageId + 1; index < chat.length; index++) {
                if (index in chat && !chat[index].is_system) depth++;
            }
        }`);
    return { adapter: 'isomorphic-git', changes };
}
