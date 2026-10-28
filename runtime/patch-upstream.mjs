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
    return { adapter: 'isomorphic-git', changes };
}
