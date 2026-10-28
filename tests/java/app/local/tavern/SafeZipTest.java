package app.local.tavern;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Standalone host tests: no Android runtime, test framework, or network needed. */
public final class SafeZipTest {
    private static Path workspace;
    private static int passed;

    @FunctionalInterface private interface Check { void run() throws Exception; }

    public static void main(String[] args) throws Exception {
        workspace = Files.createTempDirectory("local-tavern-zip-tests-");
        try {
            check("ordinary files, binary content, Unicode and wrapper directory", SafeZipTest::ordinaryArchive);
            check("parent traversal cannot escape staging", SafeZipTest::traversal);
            check("absolute and Windows paths are rejected", SafeZipTest::foreignPaths);
            check("duplicate normalized file names cannot overwrite", SafeZipTest::duplicateAliases);
            check("duplicate normalized directory names are rejected", SafeZipTest::duplicateDirectories);
            check("existing destination files are preserved", SafeZipTest::existingFile);
            check("a file cannot become another file's parent directory", SafeZipTest::fileDirectoryCollision);
            check("existing symlinks cannot redirect extraction", SafeZipTest::symlinkEscape);
            check("random input, empty input and empty ZIP are rejected", SafeZipTest::invalidArchives);
            check("null source is rejected", SafeZipTest::nullSource);
            check("corrupted stored payload fails CRC validation", SafeZipTest::badCrc);
            if (!Arrays.asList(args).contains("--skip-large")) {
                check("streaming payload over 512 MiB is rejected with bounded heap", SafeZipTest::oversizedFile);
            }
            System.out.println("SafeZip: " + passed + " checks passed");
        } finally {
            deleteTree(workspace);
        }
    }

    private static void check(String title, Check check) throws Exception {
        check.run();
        passed++;
        System.out.println("PASS " + title);
    }

    private static Path target(String name) { return workspace.resolve(name); }

    private static Map<String, byte[]> entries(String... pairs) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) {
            entries.put(pairs[index], pairs[index + 1].getBytes(StandardCharsets.UTF_8));
        }
        return entries;
    }

    private static byte[] zip(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return output.toByteArray();
    }

    private static void extract(byte[] archive, Path target) throws IOException {
        SafeZip.extract(new ByteArrayInputStream(archive), target.toFile());
    }

    private static IOException reject(byte[] archive, Path target) throws IOException {
        try {
            extract(archive, target);
        } catch (IOException expected) {
            return expected;
        }
        throw new AssertionError("Unsafe or invalid archive was accepted: " + target);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void ordinaryArchive() throws Exception {
        Map<String, byte[]> files = entries("extension-main/", "", "extension-main/manifest.json", "{\"display_name\":\"扩展\"}",
                "extension-main/nested/脚本.js", "export default '你好';", "README.txt", "ordinary content");
        byte[] binary = new byte[] {0, 1, 2, 127, (byte) 128, (byte) 255};
        files.put("extension-main/assets/image.bin", binary);
        Path destination = target("ordinary");
        extract(zip(files), destination);
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            if (entry.getKey().endsWith("/")) {
                require(Files.isDirectory(destination.resolve(entry.getKey())), "Directory missing");
            } else {
                require(Arrays.equals(entry.getValue(), Files.readAllBytes(destination.resolve(entry.getKey()))),
                        "Extracted bytes differ: " + entry.getKey());
            }
        }
    }

    private static void traversal() throws Exception {
        Path outside = target("outside.txt");
        Files.writeString(outside, "keep me");
        int count = 0;
        for (String path : new String[] {"../outside.txt", "deep/../../outside.txt", "deep/../file.txt"}) {
            reject(zip(entries(path, "overwrite")), target("traversal-" + count++));
            require(Files.readString(outside).equals("keep me"), "Outside file was changed");
        }
    }

    private static void foreignPaths() throws Exception {
        int count = 0;
        for (String path : new String[] {"/absolute.txt", "C:/drive.txt", "C:relative-drive.txt", "C:\\drive.txt", "folder\\file.txt", "\\\\server\\share.txt"}) {
            reject(zip(entries(path, "unsafe")), target("foreign-" + count++));
        }
    }

    private static void duplicateAliases() throws Exception {
        Path destination = target("duplicate-file");
        reject(zip(entries("nested/file.txt", "first", "nested/./file.txt", "second")), destination);
        require(Files.readString(destination.resolve("nested/file.txt")).equals("first"), "Alias overwrote first entry");
        reject(zip(entries("nested/file.txt", "first", "nested//file.txt", "second")), target("duplicate-slashes"));
    }

    private static void duplicateDirectories() throws Exception {
        reject(zip(entries("nested/", "", "nested/./", "")), target("duplicate-directory"));
    }

    private static void existingFile() throws Exception {
        Path destination = Files.createDirectory(target("existing-file"));
        Path original = destination.resolve("manifest.json");
        Files.writeString(original, "original");
        reject(zip(entries("manifest.json", "replacement")), destination);
        require(Files.readString(original).equals("original"), "Existing file was replaced");
    }

    private static void fileDirectoryCollision() throws Exception {
        Path destination = target("file-directory-collision");
        reject(zip(entries("nested", "original", "nested/file.txt", "unsafe")), destination);
        require(Files.readString(destination.resolve("nested")).equals("original"), "Original file was replaced");
    }

    private static void symlinkEscape() throws Exception {
        Path destination = Files.createDirectory(target("symlink"));
        Path outside = Files.createDirectory(target("symlink-outside"));
        Files.createSymbolicLink(destination.resolve("linked"), outside);
        reject(zip(entries("linked/escaped.txt", "unsafe")), destination);
        require(!Files.exists(outside.resolve("escaped.txt")), "File escaped through an existing symlink");
    }

    private static void invalidArchives() throws Exception {
        reject("this is not a ZIP".getBytes(StandardCharsets.UTF_8), target("not-zip"));
        reject(new byte[0], target("empty-input"));
        reject(zip(new LinkedHashMap<>()), target("empty-zip"));
    }

    private static void nullSource() throws Exception {
        try {
            SafeZip.extract(null, target("null-source").toFile());
        } catch (IOException expected) {
            return;
        }
        throw new AssertionError("Null source accepted");
    }

    private static void badCrc() throws Exception {
        byte[] payload = "recognizable original payload".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        CRC32 crc = new CRC32();
        crc.update(payload);
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            ZipEntry entry = new ZipEntry("payload.txt");
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(payload.length);
            entry.setCompressedSize(payload.length);
            entry.setCrc(crc.getValue());
            zip.putNextEntry(entry);
            zip.write(payload);
            zip.closeEntry();
        }
        byte[] archive = output.toByteArray();
        int payloadOffset = 30 + "payload.txt".getBytes(StandardCharsets.UTF_8).length;
        archive[payloadOffset] ^= 1;
        reject(archive, target("bad-crc"));
    }

    private static void oversizedFile() throws Exception {
        // The declared size is unknown until the data descriptor is reached.
        // Real streamed bytes must enforce the bound, even for a tiny ZIP bomb.
        // Uses a 64 KiB buffer and about 512 MiB of temporary disk, never heap.
        Path archive = target("oversized.zip");
        try (OutputStream output = Files.newOutputStream(archive);
             ZipOutputStream zip = new ZipOutputStream(output)) {
            zip.setLevel(Deflater.BEST_SPEED);
            zip.putNextEntry(new ZipEntry("large.bin"));
            byte[] zeros = new byte[64 * 1024];
            long remaining = SafeZip.MAX_FILE_BYTES + 1;
            while (remaining > 0) {
                int length = (int) Math.min(zeros.length, remaining);
                zip.write(zeros, 0, length);
                remaining -= length;
            }
            zip.closeEntry();
        }
        require(Files.size(archive) < 4L * 1024 * 1024, "ZIP bomb fixture unexpectedly large");
        Path destination = target("oversized-extraction");
        try (InputStream source = Files.newInputStream(archive)) {
            try {
                SafeZip.extract(source, destination.toFile());
                throw new AssertionError("File larger than 512 MiB accepted");
            } catch (IOException expected) {
                Path partial = destination.resolve("large.bin");
                require(Files.size(partial) <= SafeZip.MAX_FILE_BYTES, "Extractor wrote bytes beyond its file bound");
            }
        } finally {
            deleteTree(destination);
            Files.deleteIfExists(archive);
        }
    }

    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
            for (Path path : (Iterable<Path>) paths.sorted(Comparator.reverseOrder())::iterator) {
                Files.deleteIfExists(path);
            }
        }
    }
}
