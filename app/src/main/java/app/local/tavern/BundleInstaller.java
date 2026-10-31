package app.local.tavern;

import android.content.Context;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

final class BundleInstaller {
    static File install(Context context) throws Exception {
        recoverRestore(context);
        JSONObject manifest;
        try (InputStream in = context.getAssets().open("bundle-manifest.json")) {
            manifest = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        }
        String expected = manifest.getString("sha256").toLowerCase(Locale.ROOT);
        if (!expected.matches("[a-f0-9]{64}")) throw new IOException("安装包校验信息无效");
        if (!"zip+zstd".equals(manifest.getString("format"))) throw new IOException("不支持的资源包格式");
        File parent = new File(context.getFilesDir(), "runtime");
        File target = new File(parent, expected);
        logCleanup(RuntimeStorage.prepare(parent, context.getCacheDir()));
        if (RuntimeStorage.isReady(parent, expected)) {
            logCleanup(RuntimeStorage.pruneObsolete(parent, expected));
            return target;
        }
        parent.mkdirs();
        File stage = new File(parent, ".install-" + UUID.randomUUID());
        File archive = File.createTempFile("tavern-", ".zip.zst", context.getCacheDir());
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            try (InputStream in = context.getAssets().open("tavern.zip.zst"); OutputStream out = new FileOutputStream(archive)) {
                byte[] buffer = new byte[64 * 1024]; int n;
                while ((n = in.read(buffer)) != -1) { sha.update(buffer, 0, n); out.write(buffer, 0, n); }
            }
            StringBuilder actual = new StringBuilder();
            for (byte b : sha.digest()) actual.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (!expected.equals(actual.toString())) throw new IOException("安装包校验失败，请重新下载安装 APK");
            try (BundleZstdInputStream decoded = new BundleZstdInputStream(archive)) {
                // SafeZip owns and closes its input. Keep the decoder open so
                // the central directory and Zstd footer are checked as well.
                unzip(new FilterInputStream(decoded) { @Override public void close() {} }, stage);
                decoded.verifyEnd();
            }
            if (!new File(stage, "android-entry.mjs").isFile() || !new File(stage, "server.js").isFile())
                throw new IOException("安装包缺少启动文件");
            Files.write(new File(stage, ".ready").toPath(), expected.getBytes(StandardCharsets.UTF_8));
            if (Files.isSymbolicLink(target.toPath())) Files.delete(target.toPath());
            else if (target.exists()) remove(target);
            move(stage, target);
            logCleanup(RuntimeStorage.pruneObsolete(parent, expected));
            RuntimeContract.data(context).mkdirs();
            RuntimeContract.plugins(context).mkdirs();
            return target;
        } finally { archive.delete(); remove(stage); }
    }

    private static void logCleanup(RuntimeStorage.CleanupReport report) {
        for (String failure : report.failures()) android.util.Log.w("LocalTavernStorage", failure);
        if (report.removedPaths > 0) android.util.Log.i("LocalTavernStorage", "Removed " + report.removedPaths
            + " obsolete runtime paths; reclaimed " + report.reclaimedBytes + " bytes");
    }

    static void unzip(InputStream source, File target) throws IOException { SafeZip.extract(source, target); }

    static String importPlugin(Context c, Uri uri, boolean server) throws Exception {
        File stage = new File(c.getCacheDir(), "plugin-" + UUID.randomUUID());
        try {
            unzip(c.getContentResolver().openInputStream(uri), stage);
            File source = stage;
            File[] children = stage.listFiles(f -> !f.getName().equals("__MACOSX") && !f.getName().startsWith("."));
            if (children != null && children.length == 1 && children[0].isDirectory()) source = children[0];
            if (server) {
                if (!new File(source, "index.js").isFile() && !new File(source, "index.mjs").isFile() && !new File(source, "index.cjs").isFile() && !new File(source, "package.json").isFile())
                    throw new IOException("服务端插件缺少 index.js、index.mjs、index.cjs 或 package.json");
            } else {
                File file = new File(source, "manifest.json");
                if (!file.isFile()) throw new IOException("扩展缺少 manifest.json，请导入 SillyTavern 扩展 ZIP");
                JSONObject metadata = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                for (String field : new String[]{"js", "css"}) {
                    String value = metadata.optString(field, "");
                    if (!value.isEmpty() && (!new File(source, value).getCanonicalPath().startsWith(source.getCanonicalPath() + "/") || !new File(source, value).isFile()))
                        throw new IOException("扩展 " + field + " 文件路径无效");
                }
            }
            String name = source == stage ? displayName(c, uri) : source.getName();
            name = name.replaceFirst("(?i)\\.zip$", "").replaceFirst("-(main|master)$", "").replaceAll("[^a-zA-Z0-9_.-]", "_");
            if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "extension-" + System.currentTimeMillis();
            File parent = server ? RuntimeContract.plugins(c) : new File(RuntimeContract.data(c), "default-user/extensions");
            parent.mkdirs(); File target = new File(parent, name);
            if (target.exists()) throw new IOException("已存在同名扩展 " + name + "。请先在酒馆中卸载，避免覆盖自定义修改。");
            File incoming = new File(parent, ".import-" + UUID.randomUUID());
            try { copyTree(source, incoming); move(incoming, target); }
            finally { remove(incoming); }
            return name;
        } finally { remove(stage); }
    }

    static String displayName(Context c, Uri uri) {
        try (Cursor cursor = c.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return "extension-" + System.currentTimeMillis();
    }
    static void backup(Context c, Uri uri) throws Exception {
        BackupArchive.Plan plan = BackupArchive.prepare(RuntimeContract.data(c), RuntimeContract.plugins(c));
        // Opening a SAF destination may truncate it: quota checks must finish first.
        try (OutputStream destination = c.getContentResolver().openOutputStream(uri)) {
            BackupArchive.write(plan, destination);
        }
    }
    static void restore(Context c, Uri uri) throws Exception {
        File stage = new File(c.getFilesDir(), ".restore-" + UUID.randomUUID());
        File oldData = new File(c.getFilesDir(), ".userdata-before-restore-" + UUID.randomUUID());
        File oldPlugins = new File(c.getFilesDir(), ".plugins-before-restore-" + UUID.randomUUID());
        File journal = new File(c.getFilesDir(), ".restore-journal.json");
        try {
            unzip(c.getContentResolver().openInputStream(uri), stage);
            JSONObject marker = new JSONObject(new String(Files.readAllBytes(new File(stage, "local-tavern-backup.json").toPath()), StandardCharsets.UTF_8));
            if (marker.getInt("format") != 1 || !new File(stage, "userdata").isDirectory()) throw new IOException("这不是受支持的本地酒馆备份");
            new File(stage, "plugins").mkdirs();
            JSONObject transaction = new JSONObject().put("oldData", oldData.getName()).put("oldPlugins", oldPlugins.getName())
                .put("hadData", RuntimeContract.data(c).exists()).put("hadPlugins", RuntimeContract.plugins(c).exists()).put("committed", false);
            writeJournal(c, transaction);
            try {
                if (RuntimeContract.data(c).exists()) move(RuntimeContract.data(c), oldData);
                if (RuntimeContract.plugins(c).exists()) move(RuntimeContract.plugins(c), oldPlugins);
                move(new File(stage, "userdata"), RuntimeContract.data(c));
                move(new File(stage, "plugins"), RuntimeContract.plugins(c));
                writeJournal(c, transaction.put("committed", true));
            } catch (Exception e) {
                recoverRestore(c);
                throw e;
            }
            remove(oldData); remove(oldPlugins); journal.delete();
        } finally { remove(stage); }
    }
    private static void writeJournal(Context c, JSONObject transaction) throws IOException {
        File temporary = new File(c.getFilesDir(), ".restore-journal.tmp");
        try (FileOutputStream out = new FileOutputStream(temporary)) {
            out.write(transaction.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync();
        }
        Files.move(temporary.toPath(), new File(c.getFilesDir(), ".restore-journal.json").toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
    private static void recoverRestore(Context c) throws Exception {
        File journal = new File(c.getFilesDir(), ".restore-journal.json");
        if (!journal.isFile()) return;
        JSONObject transaction = new JSONObject(new String(Files.readAllBytes(journal.toPath()), StandardCharsets.UTF_8));
        String dataName=transaction.getString("oldData"), pluginName=transaction.getString("oldPlugins");
        if (!dataName.matches("\\.userdata-before-restore-[a-f0-9-]+") || !pluginName.matches("\\.plugins-before-restore-[a-f0-9-]+")) throw new IOException("恢复事务记录无效");
        File oldData = new File(c.getFilesDir(), dataName), oldPlugins = new File(c.getFilesDir(), pluginName);
        if (!transaction.getBoolean("committed")) {
            if (oldData.exists()) { remove(RuntimeContract.data(c)); move(oldData, RuntimeContract.data(c)); }
            else if (!transaction.getBoolean("hadData")) remove(RuntimeContract.data(c));
            if (oldPlugins.exists()) { remove(RuntimeContract.plugins(c)); move(oldPlugins, RuntimeContract.plugins(c)); }
            else if (!transaction.getBoolean("hadPlugins")) remove(RuntimeContract.plugins(c));
        }
        remove(oldData); remove(oldPlugins); journal.delete();
    }
    private static void copyTree(File source, File target) throws IOException {
        if (Files.isSymbolicLink(source.toPath())) throw new IOException("扩展不支持符号链接");
        if (source.isDirectory()) {
            target.mkdirs(); File[] children = source.listFiles();
            if (children != null) for (File f : children) copyTree(f, new File(target, f.getName()));
        } else Files.copy(source.toPath(), target.toPath());
    }
    static void move(File from, File to) throws IOException {
        try { Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE); }
        catch (java.nio.file.AtomicMoveNotSupportedException e) { Files.move(from.toPath(), to.toPath()); }
    }
    static byte[] readAll(InputStream source) throws IOException {
        try (InputStream in = source; ByteArrayOutputStream out = new ByteArrayOutputStream()) { copy(in, out); return out.toByteArray(); }
    }
    static void copy(InputStream source, OutputStream target) throws IOException {
        if (source == null || target == null) throw new IOException("无法打开文件");
        byte[] buffer = new byte[64 * 1024]; int n;
        while ((n = source.read(buffer)) != -1) target.write(buffer, 0, n);
    }
    static void remove(File file) {
        if (!file.exists()) return;
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child);
        }
        file.delete();
    }
}
