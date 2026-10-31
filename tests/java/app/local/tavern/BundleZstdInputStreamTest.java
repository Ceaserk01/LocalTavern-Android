package app.local.tavern;

import java.io.*;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipInputStream;

/** Exercises the actual host JNI build of the production C decoder. */
public final class BundleZstdInputStreamTest {
    private static File fixtures;
    private static int checks;

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }

    private static BundleZstdInputStream open(String name) throws IOException {
        return new BundleZstdInputStream(new File(fixtures, name));
    }

    private static void reject(String name) throws Exception {
        try (BundleZstdInputStream input = open(name)) {
            input.verifyEnd();
            throw new AssertionError("Accepted invalid frame: " + name);
        } catch (IOException expected) { checks++; }
    }

    private static long descriptors() {
        java.lang.management.OperatingSystemMXBean bean = ManagementFactory.getOperatingSystemMXBean();
        return bean instanceof com.sun.management.UnixOperatingSystemMXBean
            ? ((com.sun.management.UnixOperatingSystemMXBean) bean).getOpenFileDescriptorCount() : -1;
    }

    public static void main(String[] args) throws Exception {
        fixtures = new File(args[0]);
        byte[] expected = Files.readAllBytes(new File(fixtures, "binary.raw").toPath());
        for (int size : new int[]{1, 7, 65536, 131073}) {
            try (BundleZstdInputStream input = open("binary.zst")) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[size + 8];
                int count;
                while ((count = input.read(buffer, 3, size)) != -1) {
                    check(count > 0 && count <= size, "InputStream progress/bounds");
                    output.write(buffer, 3, count);
                }
                check(Arrays.equals(expected, output.toByteArray()), "Exact binary round trip at chunk " + size);
                check(input.read() == -1 && input.read(new byte[0]) == 0, "Stable EOF");
                input.verifyEnd();
            }
        }
        try (BundleZstdInputStream input = open("binary.zst")) {
            check(input.read() == (expected[0] & 255), "Unsigned single-byte read");
            input.verifyEnd(); // Simulates ZipInputStream stopping before the frame/footer.
            check(input.read() == -1, "verifyEnd drains remaining output");
        }
        try (BundleZstdInputStream input = open("empty.zst")) {
            check(input.read() == -1, "Empty valid frame");
            input.verifyEnd();
        }
        for (String name : new String[]{"footer.zip.zst", "bad-footer.zip.zst"}) {
            try (BundleZstdInputStream input = open(name)) {
                ZipInputStream zip = new ZipInputStream(new FilterInputStream(input) {
                    @Override public void close() { /* Installer keeps the decoder open for verifyEnd. */ }
                });
                int entries = 0;
                while (zip.getNextEntry() != null) {
                    check(Arrays.equals(zip.readAllBytes(), "payload".getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                        "ZIP payload preserved");
                    entries++;
                }
                zip.close();
                check(entries == 900, "ZIP local records complete before frame footer");
                if (name.startsWith("bad-")) {
                    try { input.verifyEnd(); throw new AssertionError("Ignored corrupt frame checksum beyond ZIP footer"); }
                    catch (IOException expectedFailure) { checks++; }
                } else input.verifyEnd();
            }
        }
        try (BundleZstdInputStream input = open("binary.zst")) {
            try { input.read(null, 0, 1); throw new AssertionError("Null buffer accepted"); }
            catch (NullPointerException expectedFailure) { checks++; }
            for (int[] bounds : new int[][]{{-1,1},{0,-1},{1,8},{Integer.MAX_VALUE,1},{1,Integer.MAX_VALUE}}) {
                try { input.read(new byte[8], bounds[0], bounds[1]); throw new AssertionError("Bad bounds accepted"); }
                catch (IndexOutOfBoundsException expectedFailure) { checks++; }
            }
            check(input.read() == (expected[0] & 255), "Invalid arguments preserve usable stream");
        }
        BundleZstdInputStream closed = open("binary.zst");
        closed.close(); closed.close();
        try { closed.read(); throw new AssertionError("Closed stream accepted read"); }
        catch (IOException expectedFailure) { checks++; }

        for (String name : new String[]{"corrupt.zst", "trailing.zst", "double.zst", "skippable.zst",
                "large-window.zst", "over-limit.zst", "missing.zst"}) reject(name);
        for (String name : fixtures.list((directory, filename) -> filename.startsWith("truncated-"))) reject(name);

        // Failure paths must close native FILEs immediately, even when callers
        // retain the failed Java stream and never explicitly close it.
        long before = descriptors();
        BundleZstdInputStream[] failed = new BundleZstdInputStream[200];
        for (int index = 0; index < failed.length; index++) {
            failed[index] = open("corrupt.zst");
            try { failed[index].verifyEnd(); throw new AssertionError("Corruption accepted"); }
            catch (IOException expectedFailure) { checks++; }
        }
        long after = descriptors();
        if (before >= 0) check(after <= before + 3, "Native FILE leak on decoding failure");
        for (BundleZstdInputStream input : failed) input.close();

        // A racing close may stop reads, but must never release in-use native state.
        for (int index = 0; index < 40; index++) {
            BundleZstdInputStream input = open("binary.zst");
            AtomicReference<Throwable> unexpected = new AtomicReference<>();
            Thread reader = new Thread(() -> {
                try { byte[] buffer = new byte[257]; while (input.read(buffer) != -1) {} }
                catch (IOException closedDuringRead) { /* Expected race outcome. */ }
                catch (Throwable failure) { unexpected.set(failure); }
            });
            reader.start(); input.close(); reader.join(); input.close();
            check(unexpected.get() == null, "Concurrent read/close");
        }
        System.out.println("Bundle Zstandard JNI tests passed (" + checks + " checks)");
    }
}
