package app.local.tavern;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.UUID;

public final class RuntimeStorageTest {
    private static final String OLD = repeat('a'), CURRENT = repeat('b'), NEW = repeat('c');
    private static int assertions;
    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }
    private static String repeat(char character) {
        char[] chars = new char[64]; Arrays.fill(chars, character); return new String(chars);
    }
    private static void write(Path file, String content) throws Exception {
        Files.createDirectories(file.getParent()); Files.write(file, content.getBytes(StandardCharsets.UTF_8));
    }
    private static void ready(Path runtime, String hash) throws Exception { write(runtime.resolve(hash).resolve(".ready"), hash); }

    public static void main(String[] args) throws Exception {
        Path fixture = Files.createTempDirectory("local-tavern-storage-");
        try {
            Path runtime = fixture.resolve("runtime"), cache = fixture.resolve("cache");
            Files.createDirectories(runtime); Files.createDirectories(cache);
            Path userdata = fixture.resolve("userdata/chat.jsonl"), plugins = fixture.resolve("plugins/index.mjs");
            write(userdata, "chat data"); write(plugins, "plugin source");
            ready(runtime, OLD);
            Path abandoned = runtime.resolve(".install-" + UUID.randomUUID());
            write(abandoned.resolve("node_modules/partial.js"), "incomplete");
            Path archive = cache.resolve("tavern-123456789.zip"); write(archive, "partial archive");
            Path unrelated = cache.resolve("user-tavern-backup.zip"); write(unrelated, "keep user file");
            Path unmanaged = runtime.resolve(".install-user-not-a-uuid/file"); write(unmanaged, "unmanaged");
            RuntimeStorage.CleanupReport before = RuntimeStorage.prepare(runtime.toFile(), cache.toFile());
            check(!Files.exists(abandoned) && !Files.exists(archive), "Interrupted install staging and copied archive must be reclaimed");
            check(before.reclaimedBytes == 25, "Cleanup must report actual file bytes only");
            check(Files.exists(unrelated) && Files.exists(unmanaged), "Only installer-owned names may be cleaned");
            check(RuntimeStorage.isReady(runtime.toFile(), OLD), "Previous runtime must survive preparing a new install");

            // New extraction fails before it has a ready marker: keep the previous version.
            write(runtime.resolve(NEW).resolve("server.js"), "failed new install");
            RuntimeStorage.pruneObsolete(runtime.toFile(), NEW);
            check(Files.exists(runtime.resolve(OLD)), "Failed install must keep the previously working runtime");
            ready(runtime, CURRENT);
            write(runtime.resolve(OLD).resolve("node_modules/old.js"), "old source");
            Files.createSymbolicLink(runtime.resolve(OLD).resolve("userdata-link"), userdata.getParent());
            Files.createSymbolicLink(runtime.resolve(NEW).resolve("plugins-link"), plugins.getParent());
            Path currentLibrary = runtime.resolve(CURRENT).resolve("server.js"); write(currentLibrary, "current source");
            RuntimeStorage.CleanupReport after = RuntimeStorage.pruneObsolete(runtime.toFile(), CURRENT);
            check(!Files.exists(runtime.resolve(OLD)) && !Files.exists(runtime.resolve(NEW)), "Ready current version retires obsolete hash directories");
            check(Files.exists(currentLibrary) && RuntimeStorage.isReady(runtime.toFile(), CURRENT), "Active runtime and ready marker must be retained");
            check(Files.readString(userdata).equals("chat data") && Files.readString(plugins).equals("plugin source"), "Cleanup must never follow links into persistent user data");
            check(after.failedPaths == 0, "Normal pruning must finish without cleanup errors");

            // Neither a symlinked ready marker nor a symlinked current version may authorize pruning.
            ready(runtime, OLD);
            Files.delete(runtime.resolve(CURRENT).resolve(".ready"));
            Files.createSymbolicLink(runtime.resolve(CURRENT).resolve(".ready"), runtime.resolve(OLD).resolve(".ready"));
            check(!RuntimeStorage.isReady(runtime.toFile(), CURRENT), "Symlinked ready marker cannot authorize retirement");
            RuntimeStorage.pruneObsolete(runtime.toFile(), CURRENT);
            check(Files.exists(runtime.resolve(OLD)), "Unverified current runtime must retain the prior runtime");
            Files.delete(runtime.resolve(CURRENT).resolve(".ready")); ready(runtime, CURRENT);

            // A managed-name link at the root is unlinked; its target remains intact.
            Path linkedStage = runtime.resolve(".install-" + UUID.randomUUID());
            Files.createSymbolicLink(linkedStage, userdata.getParent());
            Path linkedZip = cache.resolve("tavern-987654321.zip"); Files.createSymbolicLink(linkedZip, userdata);
            RuntimeStorage.prepare(runtime.toFile(), cache.toFile());
            check(!Files.exists(linkedStage) && !Files.exists(linkedZip) && Files.exists(userdata), "Root-level managed links must not escape storage");
            Path linkedRoot = fixture.resolve("runtime-alias"); Files.createSymbolicLink(linkedRoot, runtime);
            RuntimeStorage.CleanupReport linkedReport = RuntimeStorage.prepare(linkedRoot.toFile(), cache.toFile());
            check(linkedReport.failedPaths == 1 && Files.exists(runtime.resolve(OLD)), "Symlinked storage roots must be refused without failing startup");
            Path notDirectory = fixture.resolve("not-directory"); write(notDirectory, "regular file");
            check(RuntimeStorage.prepare(notDirectory.toFile(), cache.toFile()).failedPaths == 1, "Cleanup I/O errors must be reported, not thrown");
            check(!RuntimeStorage.isReady(runtime.toFile(), "../userdata"), "Unmanaged version names must be rejected");

            // A realistic obsolete module tree: files are streamed/deleted, never buffered into memory.
            byte[] block = new byte[64 * 1024];
            for (int version = 0; version < 4; version++) {
                String hash = repeat((char) ('0' + version));
                ready(runtime, hash);
                for (int file = 0; file < 128; file++) {
                    Path module = runtime.resolve(hash).resolve("node_modules/pkg-" + file + "/index.js");
                    Files.createDirectories(module.getParent()); Files.write(module, block);
                }
            }
            long start = System.nanoTime();
            RuntimeStorage.CleanupReport measured = RuntimeStorage.pruneObsolete(runtime.toFile(), CURRENT);
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            check(measured.failedPaths == 0 && measured.reclaimedBytes >= 32L * 1024 * 1024, "All obsolete fixture data must be reclaimed");
            check(Files.exists(currentLibrary) && Files.exists(userdata) && Files.exists(plugins), "Large pruning must preserve current resources and persistent user content");
            System.out.println("Runtime storage: " + assertions + " assertions passed; reclaimed " + measured.reclaimedBytes
                + " bytes / " + measured.removedPaths + " paths in " + elapsedMs + " ms (host filesystem fixture, not an Android benchmark)");
        } finally {
            // Test-owned fixture only; the same non-following visitor keeps test cleanup bounded.
            try (java.util.stream.Stream<Path> entries = Files.walk(fixture)) {
                entries.sorted(java.util.Comparator.reverseOrder()).forEach(path -> { try { Files.deleteIfExists(path); } catch (Exception ignored) {} });
            }
        }
    }
}
