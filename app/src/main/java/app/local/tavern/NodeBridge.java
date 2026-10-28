package app.local.tavern;

/** Loaded only by the :runtime service; a runtime restart never tears down the UI. */
public final class NodeBridge {
    static { System.loadLibrary("node"); System.loadLibrary("local_tavern"); }
    private NodeBridge() {}
    public static native int start(String root, String data, String cache, String log, int port);
}
