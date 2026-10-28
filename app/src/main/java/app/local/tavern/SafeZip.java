package app.local.tavern;

import java.io.*;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Pure JDK extraction, usable by the Android installer and host-side adversarial tests. */
public final class SafeZip {
    public static final long MAX_TOTAL_BYTES = 2L * 1024 * 1024 * 1024;
    public static final long MAX_FILE_BYTES = 512L * 1024 * 1024;
    public static final int MAX_ENTRIES = 200000;
    private SafeZip() {}

    public static void extract(InputStream source, File target) throws IOException {
        if (source == null) throw new IOException("无法读取所选文件");
        if (!target.mkdirs() && !target.isDirectory()) throw new IOException("无法创建导入目录");
        String prefix = target.getCanonicalPath() + File.separator;
        Set<String> seen = new HashSet<>();
        long total = 0; int entries = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(source, 64 * 1024))) {
            ZipEntry entry; byte[] buffer = new byte[64 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) throw new IOException("压缩包文件数量过多");
                String name = entry.getName();
                if (name.isEmpty() || name.indexOf('\0') >= 0 || name.indexOf('\\') >= 0 || name.startsWith("/") || name.matches("^[a-zA-Z]:.*"))
                    throw new IOException("压缩包包含不安全的路径");
                for (String part : name.split("/")) if (part.equals("..")) throw new IOException("压缩包路径越界");
                File file = new File(target, name);
                String path = file.getCanonicalPath();
                if (!path.startsWith(prefix)) throw new IOException("压缩包路径越界");
                if (!seen.add(path)) throw new IOException("压缩包包含重复路径");
                if (entry.isDirectory()) {
                    if (!file.mkdirs() && !file.isDirectory()) throw new IOException("无法创建目录");
                } else {
                    File parent = file.getParentFile();
                    if (!parent.mkdirs() && !parent.isDirectory()) throw new IOException("无法创建目录");
                    if (file.exists()) throw new IOException("压缩包文件路径冲突");
                    // ZIP Unix symlink metadata is intentionally ignored: every entry is created as a regular file.
                    long fileBytes = 0;
                    try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
                        int n;
                        while ((n = zip.read(buffer)) != -1) {
                            total += n; fileBytes += n;
                            if (total > MAX_TOTAL_BYTES || fileBytes > MAX_FILE_BYTES) throw new IOException("解压数据超过大小限制");
                            out.write(buffer, 0, n);
                        }
                    }
                }
                zip.closeEntry();
            }
        }
        if (entries == 0) throw new IOException("ZIP 压缩包为空或格式不正确");
    }
}
