// Runs in the APK's isolated :runtime process, inside the bundled Node runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const value = (key, fallback) => {
    const index = process.argv.indexOf(key);
    return index >= 0 ? process.argv[index + 1] : fallback;
};
const data = path.resolve(value('--dataRoot', path.join(root, 'data')));
const port = Number(value('--port', '18766'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
fs.mkdirSync(data, { recursive: true });
const files = path.dirname(data);
const plugins = process.env.TAVERN_PLUGINS_DIR || path.join(files, 'plugins');
fs.mkdirSync(plugins, { recursive: true });
const pluginPackage = path.join(plugins, 'package.json');
if (!fs.existsSync(pluginPackage)) fs.writeFileSync(pluginPackage, '{"name":"sillytavern-plugins","type":"commonjs"}\n');

function linkDirectory(target, link) {
    if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) {
        const entries = fs.readdirSync(link).filter(name => !name.startsWith('.'));
        if (entries.length) throw new Error(`Refusing to replace a non-empty directory: ${link}`);
        fs.rmSync(link, { recursive: true });
    }
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(target, link, 'dir');
}
linkDirectory(plugins, path.join(root, 'plugins'));
linkDirectory(path.join(root, 'node_modules'), path.join(files, 'node_modules'));
const globalExtensions = path.join(data, 'global-extensions');
fs.mkdirSync(globalExtensions, { recursive: true });
linkDirectory(globalExtensions, path.join(root, 'public/scripts/extensions/third-party'));

// Preserve user tuning across APK upgrades, while keeping the in-app server local.
const configPath = path.join(data, 'config.yaml');
const hasConfig = fs.existsSync(configPath);
const config = hasConfig
    ? yaml.parse(fs.readFileSync(configPath, 'utf8')) || {}
    : yaml.parse(fs.readFileSync(path.join(root, 'default/config.yaml'), 'utf8'));
Object.assign(config, {
    dataRoot: data, port, listen: false, disableCsrfProtection: false,
});
config.browserLaunch = { ...config.browserLaunch, enabled: false };
config.protocol = { ipv4: true, ipv6: false };
config.git = { ...config.git, backend: 'builtin' };
if (!hasConfig) {
    config.enableServerPlugins = true;
    config.enableServerPluginsAutoUpdate = false;
    config.performance = { ...config.performance, useDiskCache: true, memoryCacheCapacity: '64mb' };
    config.logging = { ...config.logging, minLogLevel: 1 };
}
fs.writeFileSync(`${configPath}.tmp`, yaml.stringify(config), { mode: 0o600 });
fs.renameSync(`${configPath}.tmp`, configPath);

process.env.NODE_ENV = 'production';
process.argv = [process.argv[0], path.join(root, 'server.js'),
    '--configPath', configPath, '--dataRoot', data, '--port', String(port),
    '--listen', 'false', '--browserLaunchEnabled', 'false'];
await import('./server.js');
