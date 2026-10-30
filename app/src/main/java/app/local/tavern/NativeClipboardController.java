package app.local.tavern;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import org.json.JSONObject;
import java.util.UUID;

/** Plain-text reads only, with explicit consent for each document-scoped request. */
final class NativeClipboardController {
    private static final int MAX_TEXT = 524288; // One MiB in UTF-16.
    private final Activity activity;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView view;
    private WebMessagePort port;
    private String session;
    private long generation;
    private boolean foreground, destroyed;
    private Request pending;

    private static final class Request {
        int id;
        long generation;
        String session;
        WebMessagePort port;
        AlertDialog dialog;
        Runnable timeout;
    }

    NativeClipboardController(Activity activity) { this.activity = activity; }

    void setForeground(boolean value) {
        foreground = value;
        if (!value) finish(pending, false, "", "NotAllowedError");
    }

    void attach(WebView web) {
        if (destroyed || port != null || !local(web.getUrl())) return;
        view = web;
        final long boundGeneration = ++generation;
        session = UUID.randomUUID().toString();
        WebMessagePort[] channel = web.createWebMessageChannel();
        port = channel[0];
        final WebMessagePort boundPort = port;
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort receiving, WebMessage message) {
                if (!destroyed && generation == boundGeneration && port == boundPort) receive(message.getData());
            }
        });
        try {
            JSONObject hello = new JSONObject().put("type", "local-tavern-clipboard").put("version", 1).put("session", session);
            web.postWebMessage(new WebMessage(hello.toString(), new WebMessagePort[]{channel[1]}), Uri.parse(RuntimeContract.ORIGIN));
        } catch (Exception error) { channel[1].close(); detach(); }
    }

    void detach() {
        finish(pending, false, "", "NotAllowedError");
        generation++;
        if (port != null) port.close();
        port = null; session = null; view = null;
    }

    void destroy() { if (!destroyed) { detach(); destroyed = true; } }

    private static boolean local(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
            && uri.getPort() == RuntimeContract.PORT && uri.getUserInfo() == null;
    }

    private void receive(String data) {
        if (data == null || data.length() > 4096 || session == null) return;
        try {
            JSONObject value = new JSONObject(data);
            if (!session.equals(value.optString("session"))) return;
            Object rawId = value.opt("id");
            if (!(rawId instanceof Number)) return;
            double number = ((Number)rawId).doubleValue();
            if (!Double.isFinite(number) || number < 1 || number > Integer.MAX_VALUE || number != Math.floor(number)) return;
            int id = (int)number;
            if ("cancel".equals(value.optString("type"))) {
                if (pending != null && pending.id == id) finish(pending, false, "", "NotAllowedError");
            } else if ("read".equals(value.optString("type"))) request(id);
        } catch (Exception ignored) { /* Never inspect clipboard data on invalid input. */ }
    }

    private boolean pageFocused() {
        return foreground && !destroyed && !activity.isFinishing() && !activity.isDestroyed()
            && view != null && local(view.getUrl()) && view.isAttachedToWindow() && view.isShown()
            && view.hasWindowFocus() && view.hasFocus();
    }

    private void request(int id) {
        if (pending != null) {
            if (pending.id != id) reply(id, false, "", "NotAllowedError");
            return;
        }
        if (!pageFocused()) { reply(id, false, "", "NotAllowedError"); return; }
        Request request = new Request();
        request.id = id; request.generation = generation; request.session = session; request.port = port;
        pending = request;
        request.timeout = () -> finish(request, false, "", "NotAllowedError");
        request.dialog = new AlertDialog.Builder(activity)
            .setTitle("允许酒馆读取剪贴板文字？")
            .setMessage("本次读取会将剪贴板中的文字交给当前酒馆页面。")
            .setPositiveButton("允许", (dialog, which) -> allow(request))
            .setNegativeButton("取消", (dialog, which) -> finish(request, false, "", "NotAllowedError"))
            .setOnCancelListener(dialog -> finish(request, false, "", "NotAllowedError"))
            .create();
        request.dialog.setOnDismissListener(dialog -> {
            if (pending == request) finish(request, false, "", "NotAllowedError");
        });
        try { request.dialog.show(); if (pending == request) ui.postDelayed(request.timeout, 60000); }
        catch (Exception error) { finish(request, false, "", "NotAllowedError"); }
    }

    private boolean current(Request request) {
        return request != null && pending == request && !destroyed && foreground
            && request.generation == generation && request.port == port && request.session.equals(session)
            && view != null && local(view.getUrl()) && view.isAttachedToWindow() && view.isShown()
            && !activity.isFinishing() && !activity.isDestroyed();
    }

    private void allow(Request request) {
        // The consent dialog owns focus here. Requiring WebView window focus at
        // this point would reject the user's positive click on our own dialog.
        if (!current(request) || request.dialog == null || !request.dialog.isShowing()
            || request.dialog.getWindow() == null || !request.dialog.getWindow().getDecorView().hasWindowFocus()) {
            finish(request, false, "", "NotAllowedError"); return;
        }
        try {
            // This is deliberately the first clipboard service access. Do not
            // preflight hasPrimaryClip, inspect metadata, or coerce URI content.
            ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
            ClipData data = clipboard == null ? null : clipboard.getPrimaryClip();
            CharSequence text = data == null || data.getItemCount() == 0 ? null : data.getItemAt(0).getText();
            if (text != null && text.length() > MAX_TEXT) { finish(request, false, "", "DataError"); return; }
            String plain = text == null ? "" : text.toString();
            if (plain.length() > MAX_TEXT) { finish(request, false, "", "DataError"); return; }
            finish(request, true, plain, null);
        } catch (Exception error) { finish(request, false, "", "NotAllowedError"); }
    }

    private void finish(Request request, boolean ok, String text, String error) {
        if (request == null || pending != request) return;
        pending = null;
        if (request.timeout != null) ui.removeCallbacks(request.timeout);
        if (request.generation == generation && request.port == port && request.session.equals(session)) reply(request.id, ok, text, error);
        if (request.dialog != null && request.dialog.isShowing()) request.dialog.dismiss();
    }

    private void reply(int id, boolean ok, String text, String error) {
        if (destroyed || port == null || session == null) return;
        try {
            JSONObject value = new JSONObject().put("type", "result").put("id", id).put("session", session).put("ok", ok);
            if (ok) value.put("text", text);
            else value.put("error", error == null ? "NotAllowedError" : error);
            port.postMessage(new WebMessage(value.toString()));
        } catch (Exception ignored) { /* Never log clipboard contents. */ }
    }
}
