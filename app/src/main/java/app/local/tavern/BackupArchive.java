package app.local.tavern;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Arrays;
import java.util.Comparator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Preflights the same limits used by restore before a SAF destination is opened. */
public final class BackupArchive {
    private static final String MARKER_NAME = "local-tavern-backup.json";
    private static final byte[] MARKER = "{\"format\":1,\"app\":\"app.local.tavern\"}".getBytes(StandardCharsets.UTF_8);

    private BackupArchive() {}

    public static Plan prepare(File data, File plugins) throws IOException {
        return prepare(data, plugins, new Limits(SafeZip.MAX_TOTAL_BYTES, SafeZip.MAX_FILE_BYTES, SafeZip.MAX_ENTRIES));
    }

    static Plan prepare(File data, File plugins, Limits limits) throws IOException {
        if (!data.isDirectory()) throw new IOException("用户数据尚未准备好，请先启动酒馆后再备份");
        Counts counts = new Counts(limits);
        counts.add(MARKER_NAME, MARKER.length);
        walk(data, "userdata", counts, null);
        if (plugins.exists()) walk(plugins, "plugins", counts, null);
        return new Plan(data, plugins, limits, counts.entries, counts.bytes);
    }

    /** Writes a previously checked plan; changes or quota violations remain failures. */
    public static void write(Plan plan, OutputStream destination) throws IOException {
        if (destination == null) throw new IOException("无法打开备份保存位置");
        Counts counts = new Counts(plan.limits);
        try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(destination))) {
            counts.add(MARKER_NAME, MARKER.length);
            zip.putNextEntry(new ZipEntry(MARKER_NAME));
            zip.write(MARKER);
            zip.closeEntry();
            Writer writer = new Writer(zip, plan.limits, MARKER.length);
            walk(plan.data, "userdata", counts, writer);
            if (plan.plugins.exists()) walk(plan.plugins, "plugins", counts, writer);
            if (counts.entries != plan.entries || counts.bytes != plan.bytes) changed();
        }
    }

    private static void walk(File file, String name, Counts counts, Writer writer) throws IOException {
        // Match SafeZip's path contract, including Unix filenames containing a backslash.
        if (name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) {
            throw new IOException("文件名不支持备份恢复，请先重命名：" + name);
        }
        BasicFileAttributes attributes = Files.readAttributes(file.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()) throw new IOException("备份不支持符号链接：" + name);
        if (attributes.isDirectory()) {
            counts.add(name, 0);
            if (writer != null) writer.directory(name);
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取目录，备份未完成：" + name);
            Arrays.sort(children, Comparator.comparing(File::getName));
            for (File child : children) walk(child, name + "/" + child.getName(), counts, writer);
        } else if (attributes.isRegularFile()) {
            counts.add(name, attributes.size());
            if (writer != null) writer.file(file, name, attributes);
        } else {
            throw new IOException("备份不支持此文件类型：" + name);
        }
    }

    private static void changed() throws IOException {
        throw new IOException("备份期间数据发生变化，文件未完整保存。请关闭会修改数据的插件后重试");
    }

    private static String capacity(long bytes) {
        if (bytes >= 1024L * 1024 * 1024) return bytes / (1024L * 1024 * 1024) + " GiB";
        if (bytes >= 1024L * 1024) return bytes / (1024L * 1024) + " MiB";
        return bytes + " 字节";
    }

    public static final class Plan {
        private final File data, plugins;
        private final Limits limits;
        private final int entries;
        private final long bytes;
        private Plan(File data, File plugins, Limits limits, int entries, long bytes) {
            this.data = data; this.plugins = plugins; this.limits = limits; this.entries = entries; this.bytes = bytes;
        }
    }

    static final class Limits {
        final long totalBytes, fileBytes;
        final int entries;
        Limits(long totalBytes, long fileBytes, int entries) {
            if (totalBytes < 1 || fileBytes < 1 || entries < 1) throw new IllegalArgumentException("Invalid backup limits");
            this.totalBytes = totalBytes; this.fileBytes = fileBytes; this.entries = entries;
        }
    }

    private static final class Counts {
        private final Limits limits;
        private int entries;
        private long bytes;
        Counts(Limits limits) { this.limits = limits; }
        void add(String name, long size) throws IOException {
            if (entries == limits.entries) {
                throw new IOException("备份文件数量超过恢复上限（" + limits.entries + " 项），请先清理不需要的文件或分别导出数据");
            }
            if (size < 0 || size > limits.fileBytes) {
                throw new IOException("单个文件超过备份恢复上限（" + capacity(limits.fileBytes) + "）：" + name
                    + "。请先清理不需要的大文件，或分别导出角色和聊天");
            }
            if (size > limits.totalBytes - bytes) {
                throw new IOException("备份数据超过恢复上限（" + capacity(limits.totalBytes) + "），请先清理不需要的文件或分别导出数据");
            }
            entries++;
            bytes += size;
        }
    }

    private static final class Writer {
        private final ZipOutputStream zip;
        private final Limits limits;
        private final byte[] buffer = new byte[64 * 1024];
        private long totalBytes;
        Writer(ZipOutputStream zip, Limits limits, long initialBytes) {
            this.zip = zip; this.limits = limits; this.totalBytes = initialBytes;
        }
        void directory(String name) throws IOException {
            zip.putNextEntry(new ZipEntry(name + "/"));
            zip.closeEntry();
        }
        void file(File file, String name, BasicFileAttributes expected) throws IOException {
            zip.putNextEntry(new ZipEntry(name));
            long copied = 0;
            try (InputStream source = new FileInputStream(file)) {
                int count;
                while ((count = source.read(buffer)) != -1) {
                    if (count > limits.fileBytes - copied || count > limits.totalBytes - totalBytes) {
                        throw new IOException("备份期间文件变大，超过恢复上限：" + name + "。请关闭会修改数据的插件后重试");
                    }
                    zip.write(buffer, 0, count);
                    copied += count;
                    totalBytes += count;
                }
            }
            BasicFileAttributes after = Files.readAttributes(file.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (copied != expected.size() || !after.isRegularFile() || after.size() != expected.size()
                || !after.lastModifiedTime().equals(expected.lastModifiedTime())) changed();
            zip.closeEntry();
        }
    }
}
