package app.local.tavern;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

public final class BackupArchiveTest {
    private static int checks;

    public static void main(String[] args) throws Exception {
        Path temporary = Files.createTempDirectory("local-tavern-backup-test-");
        try {
            roundtrip(temporary.resolve("roundtrip"));
            rejectBeforeOpen(temporary.resolve("file-limit"), new BackupArchive.Limits(4096, 64, 100), "file");
            rejectBeforeOpen(temporary.resolve("total-limit"), new BackupArchive.Limits(150, 128, 100), "total");
            rejectBeforeOpen(temporary.resolve("count-limit"), new BackupArchive.Limits(4096, 128, 2), "count");
            defaultFileLimit(temporary.resolve("default-file"));
            defaultTotalLimit(temporary.resolve("default-total"));
            rejectSymlink(temporary.resolve("symlink"));
            rejectUnsupportedName(temporary.resolve("filename"));
            rejectMissingData(temporary.resolve("missing"));
            rejectChanges(temporary.resolve("changed-size"), false);
            rejectChanges(temporary.resolve("changed-count"), true);
            rejectGrowthDuringCopy(temporary.resolve("growth-during-copy"));
            exactBoundaries(temporary.resolve("exact-limits"));
            destinationFailure(temporary.resolve("write-failure"));
            System.out.println("BackupArchive: " + checks + " checks passed");
        } finally {
            try (var files = Files.walk(temporary)) {
                for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
            }
        }
    }

    private static File data(Path directory) throws IOException {
        Path data = directory.resolve("userdata");
        Files.createDirectories(data);
        return data.toFile();
    }

    private static void roundtrip(Path directory) throws Exception {
        File data = data(directory);
        File plugins = directory.resolve("plugins").toFile();
        Path chat = data.toPath().resolve("default-user/chats/角色/聊天.jsonl");
        Files.createDirectories(chat.getParent());
        byte[] content = "{\"mes\":\"完整备份\"}\n".getBytes(StandardCharsets.UTF_8);
        Files.write(chat, content);
        Files.createDirectories(data.toPath().resolve("empty-folder"));
        Files.createDirectories(plugins.toPath().resolve("test"));
        byte[] binary = new byte[150000];
        for (int i = 0; i < binary.length; i++) binary[i] = (byte) (i * 31);
        Files.write(plugins.toPath().resolve("test/payload.bin"), binary);
        BackupArchive.Plan plan = BackupArchive.prepare(data, plugins);
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        BackupArchive.write(plan, result);
        Path restored = directory.resolve("restored");
        SafeZip.extract(new ByteArrayInputStream(result.toByteArray()), restored.toFile());
        check(Arrays.equals(content, Files.readAllBytes(restored.resolve("userdata/default-user/chats/角色/聊天.jsonl"))), "chat roundtrip");
        check(Arrays.equals(binary, Files.readAllBytes(restored.resolve("plugins/test/payload.bin"))), "binary plugin roundtrip");
        check(Files.isDirectory(restored.resolve("userdata/empty-folder")), "empty directory preserved");
        check(Files.readString(restored.resolve("local-tavern-backup.json")).equals("{\"format\":1,\"app\":\"app.local.tavern\"}"), "restore marker preserved");
        passed("a successful archive restores chat, plugins, empty directories and format marker");
    }

    private static void rejectBeforeOpen(Path directory, BackupArchive.Limits limits, String kind) throws Exception {
        File data = data(directory);
        if (kind.equals("file")) Files.write(data.toPath().resolve("large.bin"), new byte[65]);
        else if (kind.equals("total")) {
            Files.write(data.toPath().resolve("a.bin"), new byte[80]);
            Files.write(data.toPath().resolve("b.bin"), new byte[80]);
        } else Files.write(data.toPath().resolve("one.bin"), new byte[1]);
        AtomicBoolean opened = new AtomicBoolean();
        expectFailure(() -> {
            BackupArchive.Plan plan = BackupArchive.prepare(data, directory.resolve("plugins").toFile(), limits);
            opened.set(true);
            BackupArchive.write(plan, new ByteArrayOutputStream());
        }, "恢复上限");
        check(!opened.get(), "destination must stay unopened when " + kind + " quota fails");
        passed(kind + " quota is checked before opening or truncating a destination");
    }

    private static void defaultFileLimit(Path directory) throws Exception {
        File data = data(directory);
        try (RandomAccessFile sparse = new RandomAccessFile(new File(data, "oversized.bin"), "rw")) {
            sparse.setLength(SafeZip.MAX_FILE_BYTES + 1);
        }
        expectFailure(() -> BackupArchive.prepare(data, directory.resolve("plugins").toFile()), "512 MiB");
        passed("actual 512 MiB+1 sparse file is rejected by the default restore-compatible quota");
    }

    private static void defaultTotalLimit(Path directory) throws Exception {
        File data = data(directory);
        for (int i = 0; i < 5; i++) {
            try (RandomAccessFile sparse = new RandomAccessFile(new File(data, i + ".bin"), "rw")) {
                sparse.setLength(SafeZip.MAX_FILE_BYTES);
            }
        }
        expectFailure(() -> BackupArchive.prepare(data, directory.resolve("plugins").toFile()), "2 GiB");
        passed("default 2 GiB total quota counts all otherwise-valid sparse files");
    }

    private static void rejectSymlink(Path directory) throws Exception {
        File data = data(directory);
        Path outside = directory.resolve("outside.txt");
        Files.writeString(outside, "must not be backed up");
        Files.createSymbolicLink(data.toPath().resolve("link"), outside);
        expectFailure(() -> BackupArchive.prepare(data, directory.resolve("plugins").toFile()), "符号链接");
        passed("symlink content cannot enter a backup which restore would interpret differently");
    }

    private static void rejectUnsupportedName(Path directory) throws Exception {
        File data = data(directory);
        Files.writeString(data.toPath().resolve("back\\slash.txt"), "unsupported name");
        expectFailure(() -> BackupArchive.prepare(data, directory.resolve("plugins").toFile()), "重命名");
        passed("filenames rejected by SafeZip are rejected before export");
    }

    private static void rejectMissingData(Path directory) throws Exception {
        expectFailure(() -> BackupArchive.prepare(directory.resolve("missing").toFile(), directory.resolve("plugins").toFile()), "尚未准备好");
        passed("an archive lacking the required userdata root cannot be reported as a backup");
    }

    private static void rejectChanges(Path directory, boolean addFile) throws Exception {
        File data = data(directory);
        Path file = data.toPath().resolve("data.bin");
        Files.write(file, new byte[16]);
        BackupArchive.Plan plan = BackupArchive.prepare(data, directory.resolve("plugins").toFile(), new BackupArchive.Limits(4096, 64, 100));
        if (addFile) Files.write(data.toPath().resolve("added.bin"), new byte[1]);
        else Files.write(file, new byte[65]);
        expectFailure(() -> BackupArchive.write(plan, new ByteArrayOutputStream()), addFile ? "发生变化" : "恢复上限");
        passed((addFile ? "file-count" : "file-size") + " changes after preflight cannot produce a successful export");
    }

    private static void destinationFailure(Path directory) throws Exception {
        File data = data(directory);
        Files.writeString(data.toPath().resolve("chat.jsonl"), "message");
        BackupArchive.Plan plan = BackupArchive.prepare(data, directory.resolve("plugins").toFile());
        expectFailure(() -> BackupArchive.write(plan, new OutputStream() {
            @Override public void write(int value) throws IOException { throw new IOException("destination full"); }
        }), "destination full");
        passed("destination write errors cannot be mistaken for a successful backup");
    }

    private static void rejectGrowthDuringCopy(Path directory) throws Exception {
        File data = data(directory);
        File source = new File(data, "growing.bin");
        byte[] random = new byte[1024 * 1024];
        new Random(73421).nextBytes(random);
        Files.write(source.toPath(), random);
        BackupArchive.Plan plan = BackupArchive.prepare(data, directory.resolve("plugins").toFile(), new BackupArchive.Limits(2 * 1024 * 1024, random.length, 100));
        AtomicBoolean appended = new AtomicBoolean();
        OutputStream destination = new OutputStream() {
            private void grow() throws IOException {
                if (appended.compareAndSet(false, true)) {
                    try (RandomAccessFile file = new RandomAccessFile(source, "rw")) { file.setLength(random.length + 1); }
                }
            }
            @Override public void write(int value) throws IOException { grow(); }
            @Override public void write(byte[] value, int offset, int length) throws IOException { grow(); }
        };
        expectFailure(() -> BackupArchive.write(plan, destination), "文件变大");
        check(appended.get(), "test must grow the source while output is being streamed");
        passed("streaming quotas detect growth after a file has already begun copying");
    }

    private static void exactBoundaries(Path directory) throws Exception {
        File data = data(directory);
        Files.write(new File(data, "exact.bin").toPath(), new byte[64]);
        long markerSize = "{\"format\":1,\"app\":\"app.local.tavern\"}".getBytes(StandardCharsets.UTF_8).length;
        BackupArchive.Plan plan = BackupArchive.prepare(data, directory.resolve("plugins").toFile(), new BackupArchive.Limits(markerSize + 64, 64, 3));
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        BackupArchive.write(plan, result);
        SafeZip.extract(new ByteArrayInputStream(result.toByteArray()), directory.resolve("restored").toFile());
        check(Files.size(directory.resolve("restored/userdata/exact.bin")) == 64, "exact-boundary backup restores");
        passed("file, byte and entry quotas are inclusive at the allowed boundary");
    }

    private interface Operation { void run() throws Exception; }
    private static void expectFailure(Operation operation, String message) throws Exception {
        try { operation.run(); throw new AssertionError("Expected an IOException"); }
        catch (IOException expected) {
            if (!expected.getMessage().contains(message)) throw new AssertionError("Unexpected error: " + expected, expected);
        }
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static void passed(String message) { checks++; System.out.println("PASS " + message); }
}
