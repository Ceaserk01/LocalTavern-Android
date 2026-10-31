// Local, offline execution gates for the exact packaged Node dependency tree.
// TAVERN_BUNDLE_ROOT may point to a temporary extraction of the final APK asset.
// Does not start a server, download models, or write inside that dependency tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(script), '..');
const root = path.resolve(process.env.TAVERN_BUNDLE_ROOT || path.join(project, '.cache/bundle'));
const worker = process.argv.indexOf('--worker');
// ONNX IR 8/opset 13: y = Identity(x), float32 shape [3]. No model download.
const identityModel = Buffer.from('CAg6QwoQCgF4EgF5IghJZGVudGl0eRINc2xpbV9pZGVudGl0eVoPCgF4EgoKCAgBEgQKAggDYg8KAXkSCgoICAESBAoCCANCAhAN', 'base64');
const text = '中文 tokenizer 正常工作 🧪\nlocal model API';

async function checkOnnx(mode) {
    const reads = [];
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const name = file instanceof URL ? fileURLToPath(file) : String(file);
        if (name.endsWith('.wasm')) reads.push(path.resolve(name));
        return readFileSync.call(this, file, ...args);
    };
    try {
        const require = createRequire(path.join(root, 'package.json'));
        // This executes the application's real Android WASM configuration.
        await import(pathToFileURL(path.join(root, 'src/transformers.js')));
        const { env } = await import(pathToFileURL(require.resolve('sillytavern-transformers')));
        const ort = require('onnxruntime-web');
        assert.equal(env.backends.onnx.wasm, ort.env.wasm);
        assert.equal(ort.env.wasm.numThreads, 1);
        const wasmPath = path.join(root, 'node_modules/sillytavern-transformers/dist') + path.sep;
        assert.equal(ort.env.wasm.wasmPaths, wasmPath);
        ort.env.wasm.simd = mode === 'simd';
        const session = await ort.InferenceSession.create(identityModel, { executionProviders: ['wasm'] });
        try {
            const input = [1.25, -2.5, 3];
            const output = await session.run({ x: new ort.Tensor('float32', Float32Array.from(input), [3]) });
            assert.equal(output.y.type, 'float32');
            assert.deepEqual(output.y.dims, [3]);
            assert.deepEqual([...output.y.data], input);
            const loaded = mode === 'simd' ? 'ort-wasm-simd.wasm' : 'ort-wasm.wasm';
            assert.ok(reads.includes(path.join(wasmPath, loaded)), `Expected local ${loaded} to be loaded`);
            return { mode, passed: true, numThreads: 1, output: [...output.y.data],
                modelBytes: identityModel.length, wasmReads: reads.map(file => path.relative(root, file)) };
        } finally {
            if (typeof session.release === 'function') await session.release();
        }
    } finally {
        fs.readFileSync = readFileSync;
    }
}

function checkTiktoken() {
    const require = createRequire(path.join(root, 'package.json'));
    const tiktoken = require('tiktoken');
    const results = [];
    for (const model of ['gpt-4', 'gpt-4o']) {
        const encoder = tiktoken.encoding_for_model(model);
        try {
            const tokens = encoder.encode(text);
            assert.ok(tokens.length > 0);
            assert.equal(new TextDecoder().decode(encoder.decode(tokens)), text);
            results.push({ model, passed: true, tokenCount: tokens.length });
        } finally {
            encoder.free();
        }
    }
    return { passed: true, cases: results, text };
}

if (worker !== -1) {
    const mode = process.argv[worker + 1];
    assert.ok(['simd', 'scalar'].includes(mode), 'Unknown worker mode');
    process.chdir(root);
    console.log(JSON.stringify(await checkOnnx(mode)));
} else {
    const reportFile = path.resolve(process.env.TAVERN_WASM_REPORT || path.join(project, '.cache/wasm-smoke.json'));
    const reportRelative = path.relative(root, reportFile);
    assert.ok(reportRelative.startsWith(`..${path.sep}`) || path.isAbsolute(reportRelative),
        'Report must be outside the target bundle tree');
    const started = performance.now();
    const report = { passed: false, scope: 'Host Node, offline ONNX SIMD/scalar Identity inference and real tiktoken roundtrips; no Android/emulator assertion',
        driverRuntime: process.version, targetRoot: root, onnx: [] };
    try {
        for (const mode of ['simd', 'scalar']) {
            // ONNX WASM is initialized once per process; separate processes make
            // these independent checks of both shipped binary variants.
            const child = spawnSync(process.execPath, [script, '--worker', mode], {
                env: { ...process.env, TAVERN_BUNDLE_ROOT: root }, encoding: 'utf8',
                timeout: 60000, maxBuffer: 1024 * 1024,
            });
            assert.ifError(child.error);
            assert.equal(child.status, 0, `${mode} worker failed: ${child.stderr || child.stdout}`);
            report.onnx.push(JSON.parse(child.stdout.trim()));
        }
        report.tiktoken = checkTiktoken();
        report.passed = true;
    } catch (error) {
        report.error = error.stack || String(error);
        process.exitCode = 1;
    }
    report.elapsedMs = Math.round(performance.now() - started);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.log(`Report: ${reportFile}`);
}
