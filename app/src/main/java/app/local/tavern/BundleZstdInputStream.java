package app.local.tavern;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;

/** Bounded, single-frame decoder used only for the APK's verified private bundle. */
final class BundleZstdInputStream extends InputStream {
    static { System.loadLibrary("tavern_bundle"); }
    private long handle;
    private final byte[] single = new byte[1];

    BundleZstdInputStream(File compressed) throws IOException {
        handle = openNative(Objects.requireNonNull(compressed, "compressed").getAbsolutePath());
        if (handle == 0) throw new IOException("Cannot open bundled runtime decoder");
    }

    @Override public synchronized int read() throws IOException {
        int count = read(single, 0, 1);
        return count < 0 ? -1 : single[0] & 255;
    }

    @Override public synchronized int read(byte[] bytes, int offset, int length) throws IOException {
        Objects.requireNonNull(bytes, "bytes");
        if (offset < 0 || length < 0 || offset > bytes.length - length)
            throw new IndexOutOfBoundsException();
        if (handle == 0) throw new IOException("Bundled runtime decoder is closed");
        if (length == 0) return 0;
        try {
            return readNative(handle, bytes, offset, length);
        } catch (IOException | RuntimeException | Error failure) {
            // Native state becomes unusable after a decoder/JNI error. Ensure
            // that the FILE and decoder allocations are released immediately.
            close();
            throw failure;
        }
    }

    /** Drain the ZIP footer and require a complete frame with no trailing input. */
    synchronized void verifyEnd() throws IOException {
        byte[] buffer = new byte[64 * 1024];
        while (read(buffer) != -1) { /* Bound and validate all remaining output. */ }
    }

    @Override public synchronized void close() {
        long current = handle;
        handle = 0;
        if (current != 0) closeNative(current);
    }

    private static native long openNative(String path) throws IOException;
    private static native int readNative(long handle, byte[] output, int offset, int length) throws IOException;
    private static native void closeNative(long handle);
}
