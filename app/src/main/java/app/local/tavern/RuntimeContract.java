package app.local.tavern;

import android.content.Context;
import java.io.File;

/** Paths shared by the UI process, isolated Node process and the bootstrap script. */
public final class RuntimeContract {
    public static final int PORT = 18766;
    public static final String ORIGIN = "http://127.0.0.1:" + PORT;
    public static final String ACTION_STOP = "app.local.tavern.STOP_RUNTIME";
    private RuntimeContract() {}
    public static File data(Context c) { return new File(c.getFilesDir(), "userdata"); }
    public static File plugins(Context c) { return new File(c.getFilesDir(), "plugins"); }
    public static File log(Context c) { return new File(c.getFilesDir(), "runtime.log"); }
    public static File status(Context c) { return new File(c.getFilesDir(), "runtime-status.json"); }
}
