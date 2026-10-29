import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { patchUpstream } from '../runtime/patch-upstream.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(project, 'upstream.lock.json'), 'utf8'));
const source = path.join(project, 'upstream/SillyTavern');
const stage = path.join(project, '.cache/bundle');
const assets = path.join(project, 'app/src/main/assets');
await fs.mkdir(path.dirname(source), { recursive: true });
try { await fs.access(path.join(source, 'package.json')); }
catch {
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', lock.repository, source], { stdio: 'inherit' });
    execFileSync('git', ['checkout', lock.commit], { cwd: source, stdio: 'inherit' });
}
let commit;
try { await fs.access(path.join(source, '.git')); }
catch {
    const snapshot = JSON.parse(await fs.readFile(path.join(source, '.local-tavern-snapshot.json'), 'utf8'));
    if (snapshot.commit !== lock.commit) throw new Error('Source snapshot does not match pinned upstream');
    for (const [file, expected] of Object.entries(snapshot.files)) {
        const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(source, file))).digest('hex');
        if (actual !== expected) throw new Error(`Source snapshot modified: ${file}`);
    }
    commit = snapshot.commit;
}
if (!commit) {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', '.'], { cwd: source, stdio: 'inherit' });
}
if (commit !== lock.commit) throw new Error(`Upstream differs from pinned revision: ${commit}`);
if (process.argv.includes('--verify-source')) {
    console.log(`Verified upstream source: ${lock.version} / ${commit}`);
    process.exit(0);
}
if (!process.argv.includes('--skip-install')) {
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
}
await fs.rm(stage, { recursive: true, force: true });
const excluded = new Set(['.git', 'data', 'backups', 'node_modules', 'tests', '.github', '.vscode', '.gemini']);
await fs.cp(source, stage, { recursive: true, filter: p => p === source || !excluded.has(path.relative(source, p).split(path.sep)[0]) });
await fs.cp(path.join(source, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, dereference: true,
    filter: p => !p.split(path.sep).includes('.bin') });
const patches = await patchUpstream(stage);
await fs.copyFile(path.join(project, 'runtime/android-entry.mjs'), path.join(stage, 'android-entry.mjs'));
// Install before any upstream module or extension can create/revoke a download URL.
await fs.copyFile(path.join(project, 'runtime/android-downloads.js'), path.join(stage, 'public/android-downloads.js'));
const indexFile = path.join(stage, 'public/index.html');
const indexHtml = await fs.readFile(indexFile, 'utf8');
if (!indexHtml.includes('<head>')) throw new Error('Upstream index has no download-hook insertion point');
await fs.writeFile(indexFile, indexHtml.replace('<head>', '<head>\n    <script src="/android-downloads.js"></script>'));

// Bake frontend libraries on the build machine, never on the phone's first start.
process.chdir(stage);
globalThis.DATA_ROOT = path.join(stage, 'data');
const require = createRequire(path.join(stage, 'package.json'));
const webpack = require('webpack');
const { default: getConfig } = await import(pathToFileURL(path.join(stage, 'webpack.config.js')));
const webpackConfig = getConfig({ forceDist: true });
webpackConfig.cache = false;
webpackConfig.output.path = path.join(stage, 'android-dist');
await new Promise((resolve, reject) => {
    const compiler = webpack(webpackConfig);
    compiler.run((error, stats) => compiler.close(() => {
        if (error) return reject(error);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        console.log(stats.toString({ all: false, timings: true }));
        resolve();
    }));
});
await fs.writeFile(path.join(stage, 'src/middleware/webpack-serve.js'), `import path from 'node:path';
import { serverDirectory } from '../server-directory.js';
export default function getWebpackServeMiddleware() {
 const middleware = (req,res,next) => req.method === 'GET' && req.path === '/lib.js'
  ? res.sendFile(path.join(serverDirectory, 'android-dist/lib.js')) : next();
 middleware.runWebpackCompiler = async () => {};
 return middleware;
}
`);
await fs.rm(path.join(stage, 'data'), { recursive: true, force: true });
await fs.rm(path.join(stage, 'dist'), { recursive: true, force: true });
// These locations are linked to persistent private storage by android-entry.
await fs.rm(path.join(stage, 'plugins'), { recursive: true, force: true });
await fs.rm(path.join(stage, 'public/scripts/extensions/third-party'), { recursive: true, force: true });
await fs.mkdir(assets, { recursive: true });
const bundle = path.join(assets, 'tavern.zip');
execFileSync('python3', [path.join(project, 'scripts/zip_bundle.py'), stage, bundle], { stdio: 'inherit' });
const sha256 = crypto.createHash('sha256').update(await fs.readFile(bundle)).digest('hex');
const manifest = { version: lock.version, upstreamCommit: commit, sha256, patches };
await fs.writeFile(path.join(assets, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
