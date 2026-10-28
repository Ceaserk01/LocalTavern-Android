package app.local.tavern;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/** Bounded ownership of extracted runtime resources; never follows a symlink. */
final class RuntimeStorage {
    private static final Pattern VERSION = Pattern.compile("[a-f0-9]{64}");
    private static final Pattern STAGING = Pattern.compile("\\.install-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    private static final Pattern TEMPORARY_ZIP = Pattern.compile("tavern-[0-9]+\\.zip");
    private RuntimeStorage() {}

    static final class CleanupReport {
        long removedPaths;
        long reclaimedBytes;
        int failedPaths;
        private final List<String> failures = new ArrayList<>();
        List<String> failures() { return Collections.unmodifiableList(failures); }
        private void failed(Path path, IOException error) {
            failedPaths++;
            if (failures.size() < 10) failures.add(path + ": " + error.getMessage());
        }
    }

    /** Run before any fast-path return. Interrupted installs have no active writer here. */
    static CleanupReport prepare(File runtime, File cache) {
        CleanupReport report = new CleanupReport();
        cleanChildren(runtime.toPath(), name -> STAGING.matcher(name).matches(), report);
        // File.createTempFile("tavern-", ".zip", cache) is used only by this installer.
        cleanChildren(cache.toPath(), name -> TEMPORARY_ZIP.matcher(name).matches(), report);
        return report;
    }

    static boolean isReady(File runtime, String version) {
        if (!VERSION.matcher(version).matches()) return false;
        Path root = runtime.toPath();
        Path current = root.resolve(version);
        Path marker = current.resolve(".ready");
        if (Files.isSymbolicLink(root) || !Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)
            || !Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)) return false;
        try {
            return Files.size(marker) == 64
                && version.equals(new String(Files.readAllBytes(marker), StandardCharsets.US_ASCII));
        } catch (IOException error) { return false; }
    }

    /** A failed new install cannot retire a previously working runtime. */
    static CleanupReport pruneObsolete(File runtime, String currentVersion) {
        CleanupReport report = new CleanupReport();
        if (!isReady(runtime, currentVersion)) return report;
        cleanChildren(runtime.toPath(), name -> VERSION.matcher(name).matches() && !name.equals(currentVersion), report);
        return report;
    }

    private interface OwnedName { boolean matches(String name); }
    private static void cleanChildren(Path root, OwnedName owned, CleanupReport report) {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(root)) {
            report.failed(root, new IOException("Refusing to clean a symlinked storage root"));
            return;
        }
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(root)) {
            for (Path entry : entries) if (owned.matches(entry.getFileName().toString())) deleteTree(entry, report);
        } catch (IOException error) { report.failed(root, error); }
    }

    private static void deleteTree(Path root, CleanupReport report) {
        try {
            // The default walk does not follow links, including links inside old versions.
            Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                    try {
                        Files.delete(file);
                        report.removedPaths++;
                        if (attributes.isRegularFile()) report.reclaimedBytes += attributes.size();
                    } catch (IOException error) { report.failed(file, error); }
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFileFailed(Path file, IOException error) {
                    report.failed(file, error);
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult postVisitDirectory(Path directory, IOException visitError) {
                    if (visitError != null) report.failed(directory, visitError);
                    try { Files.delete(directory); report.removedPaths++; }
                    catch (IOException error) { report.failed(directory, error); }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException error) { report.failed(root, error); }
    }
}
