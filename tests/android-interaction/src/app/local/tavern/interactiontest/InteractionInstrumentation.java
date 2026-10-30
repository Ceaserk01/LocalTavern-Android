package app.local.tavern.interactiontest;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.lang.reflect.Field;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Test APK only: no component from this file is included in the product APK. */
public final class InteractionInstrumentation extends Instrumentation {
    private static final String TARGET = "app.local.tavern";
    private static final String ORIGIN = "http://127.0.0.1:18766";
    private static final String TYPED = "NativeInput1234";
    private static final String CLIPBOARD_TITLE = "允许酒馆读取剪贴板文字？";
    private static final String CLIPBOARD_MESSAGE = "本次读取会将剪贴板中的文字交给当前酒馆页面。";
    private final JSONObject report = new JSONObject();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String key = "__ltInteraction_" + UUID.randomUUID().toString().replace("-", "");
    private Activity activity;
    private WebView web;
    private ClipboardManager clipboard;
    private ClipData previousClip;
    private UiAutomation automation;
    private Integer previousAccessibilityFlags;
    private View previousNativeFocus;
    private boolean capturedPage, capturedClipboard, changedClipboard, previousIme;
    private boolean disposable, allowOnboarding, allowClipboardConsent;
    private String phase = "guard";

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        disposable = args != null && "1".equals(args.getString("disposable"));
        allowOnboarding = args != null && "1".equals(args.getString("allowOnboarding"));
        allowClipboardConsent = args != null && "1".equals(args.getString("allowClipboardConsent"));
        start();
    }

    @Override public void onStart() {
        String error = "";
        try {
            require(disposable && Build.VERSION.SDK_INT >= 30
                && ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)), "ERR_NOT_DISPOSABLE_EMULATOR");
            require(TARGET.equals(getTargetContext().getPackageName()), "ERR_WRONG_TARGET");
            report.put("androidApi", Build.VERSION.SDK_INT);
            phase = "launch";
            Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(TARGET, TARGET + ".MainActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(intent);
            web = ui(() -> {
                Field field = activity.getClass().getDeclaredField("web");
                field.setAccessible(true);
                return (WebView)field.get(activity);
            });
            require(web != null, "ERR_NO_WEBVIEW");
            phase = "ready";
            long startupDeadline = SystemClock.uptimeMillis() + 90000;
            waitUntil(90000, () -> {
                if (!ui(() -> web.getVisibility() == View.VISIBLE && web.getUrl() != null
                    && web.getUrl().startsWith(ORIGIN + "/"))) return false;
                return evaluate("(()=>({ready:location.origin===" + quote(ORIGIN)
                    + "&&Boolean(document.querySelector('#send_textarea'))&&Boolean(window.SillyTavern)}))()").optBoolean("ready");
            }, "ERR_LOCAL_PAGE_NOT_READY");

            waitForInteractionReady(startupDeadline);

            phase = "capture";
            previousNativeFocus = ui(() -> activity.getCurrentFocus());
            previousIme = imeVisible();
            clipboard = activity.getSystemService(ClipboardManager.class);
            JSONObject setup = evaluate("(()=>{const area=document.querySelector('#send_textarea');"
                + "const state=window[" + quote(key) + "]={area,originalDraft:area.value,"
                + "originalActive:document.activeElement,originalStart:area.selectionStart,originalEnd:area.selectionEnd,"
                + "scrollX,scrollY,chatScroll:document.querySelector('#chat')?.scrollTop,disposed:false};"
                + "const r=area.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);"
                + "return{localOrigin:location.origin===" + quote(ORIGIN) + ",editable:!area.disabled&&!area.readOnly,disabled:area.disabled,readOnly:area.readOnly,visible:document.visibilityState==='visible',"
                + "textareaHasSize:r.width>0&&r.height>0,textareaHitAtCenter:hit===area||area.contains(hit)};})()");
            capturedPage = true;
            require(setup.optBoolean("localOrigin") && setup.optBoolean("editable") && setup.optBoolean("visible"), "ERR_TEXTAREA_NOT_EDITABLE");
            report.put("localOriginVerified", true);
            report.put("textareaDisabled", setup.optBoolean("disabled"));
            report.put("textareaReadOnly", setup.optBoolean("readOnly"));
            report.put("textareaHasSize", setup.optBoolean("textareaHasSize"));
            report.put("textareaHitAtCenter", setup.optBoolean("textareaHitAtCenter"));
            report.put("hardwareKeyboardPresent", activity.getResources().getConfiguration().keyboard != Configuration.KEYBOARD_NOKEYS);
            require(setup.optBoolean("textareaHasSize") && setup.optBoolean("textareaHitAtCenter"), "ERR_TEXTAREA_OCCLUDED_OR_HIDDEN");
            evaluate("(()=>{const s=window[" + quote(key) + "];s.tap=e=>{s.textareaTrusted=e.isTrusted;};"
                + "s.area.addEventListener('pointerdown',s.tap);s.area.value='';s.area.dispatchEvent(new Event('input',{bubbles:true}));"
                + "s.area.scrollIntoView({block:'center'});return{ok:true};})()");

            phase = "nativeFocus";
            tap("document.querySelector('#send_textarea')");
            waitUntil(5000, () -> {
                JSONObject state = evaluate("(()=>({focused:document.hasFocus(),active:document.activeElement===document.querySelector('#send_textarea'),trusted:window[" + quote(key) + "].textareaTrusted===true}))()");
                boolean nativeFocus = ui(() -> web.hasFocus());
                report.put("nativeWebViewFocused", nativeFocus);
                report.put("nativeWindowFocused", ui(() -> web.hasWindowFocus()));
                report.put("documentFocused", state.optBoolean("focused"));
                report.put("textareaActive", state.optBoolean("active"));
                report.put("trustedTextareaTap", state.optBoolean("trusted"));
                return nativeFocus && state.optBoolean("focused") && state.optBoolean("active") && state.optBoolean("trusted");
            }, "ERR_NATIVE_TEXTAREA_FOCUS");
            report.put("nativeWebViewFocused", true);
            report.put("documentFocused", true);
            report.put("trustedTextareaTap", true);
            report.put("imeVisibleImmediatelyAfterTap", imeVisible());
            long automaticImeDeadline = SystemClock.uptimeMillis() + 2000;
            while (!imeVisible() && SystemClock.uptimeMillis() < automaticImeDeadline) SystemClock.sleep(50);
            report.put("imeVisibleAfterTap", imeVisible());
            report.put("imeVisibleAfterAutomaticWait", imeVisible());
            InputMethodManager ime = activity.getSystemService(InputMethodManager.class);
            ui(() -> { ime.showSoftInput(web, InputMethodManager.SHOW_FORCED); return null; });
            long imeDeadline = SystemClock.uptimeMillis() + 2500;
            while (!imeVisible() && SystemClock.uptimeMillis() < imeDeadline) SystemClock.sleep(50);
            report.put("imeVisibleAfterExplicitRequest", imeVisible());
            report.put("imeAcceptingText", ui(() -> ime.isAcceptingText()));

            phase = "nativeTyping";
            evaluate("(()=>{const s=window[" + quote(key) + "];s.input=e=>{if(e.isTrusted)s.nativeInputSeen=true;};s.area.addEventListener('input',s.input);return{ok:true};})()");
            sendStringSync(TYPED);
            waitUntil(5000, () -> evaluate("(()=>{const s=window[" + quote(key) + "];return{matches:s.area.value===" + quote(TYPED)
                + ",trusted:s.nativeInputSeen===true};})()").optBoolean("matches"), "ERR_NATIVE_TYPING");
            JSONObject typing = evaluate("(()=>{const s=window[" + quote(key) + "];return{matches:s.area.value===" + quote(TYPED)
                + ",trusted:s.nativeInputSeen===true};})()");
            require(typing.optBoolean("trusted"), "ERR_TYPING_EVENT_NOT_TRUSTED");
            report.put("nativeTypingMatches", true);
            report.put("trustedInputEvent", true);

            phase = "guestClipboard";
            waitForClipboardForeground();
            previousClip = ui(() -> clipboard.getPrimaryClip());
            capturedClipboard = true;
            // URI/Intent clips may have temporary grants. Leave them untouched
            // rather than risk changing their access while testing text paste.
            require(isPlainText(previousClip), "ERR_NON_TEXT_CLIPBOARD_UNTOUCHED");
            final String sentinel = "lt-guest-clipboard-" + UUID.randomUUID().toString().replace("-", "");
            final String writeSentinel = "lt-guest-write-" + UUID.randomUUID().toString().replace("-", "");
            ui(() -> { clipboard.setPrimaryClip(ClipData.newPlainText("LocalTavern QA", sentinel)); return null; });
            changedClipboard = true;
            evaluate("(()=>{const s=window[" + quote(key) + "];const button=document.createElement('button');s.button=button;"
                + "button.type='button';button.textContent='Local clipboard QA';button.style.cssText='position:fixed;left:16px;top:16px;width:180px;height:48px;z-index:2147483647;';"
                + "button.addEventListener('click',event=>{s.clipboardTrusted=event.isTrusted;s.clipboardFocused=document.hasFocus();"
                + "s.clipboardActivation=navigator.userActivation?.isActive===true;"
                + "const write=s.clipboardOperation==='write';s.clipboardSupported=typeof navigator.clipboard?.[write?'writeText':'readText']==='function';"
                + "if(!s.clipboardSupported){s.clipboardError='unsupported';s.clipboardDone=true;return;}"
                + "const timeout=setTimeout(()=>{s.clipboardError='timeout';s.clipboardDone=true;},8000);"
                + "const promise=write?navigator.clipboard.writeText(" + quote(writeSentinel) + "):navigator.clipboard.readText();"
                + "promise.then(text=>{if(!s.disposed){s.clipboardSucceeded=true;if(!write)s.clipboardMatches=text===" + quote(sentinel) + ";}})"
                + ".catch(error=>{if(!s.disposed)s.clipboardError=['NotAllowedError','SecurityError','NotFoundError'].includes(error.name)?error.name:'UnknownError';})"
                + ".finally(()=>{clearTimeout(timeout);if(!s.disposed)s.clipboardDone=true;});});document.body.appendChild(button);return{ok:true};})()");
            report.put("clipboardConsentEnabled", allowClipboardConsent);

            startClipboardOperation("write");
            JSONObject write = finishClipboardOperation();
            report.put("clipboardWriteSupported", write.optBoolean("supported"));
            report.put("clipboardWriteTrustedTap", write.optBoolean("trusted"));
            report.put("clipboardWriteDocumentFocused", write.optBoolean("focused"));
            report.put("clipboardWriteUserActivation", write.optBoolean("activation"));
            report.put("clipboardWriteSucceeded", write.optBoolean("succeeded"));
            report.put("clipboardWriteErrorName", write.optString("error"));
            boolean writeMatches = clipboardMatchesFixture(writeSentinel);
            report.put("clipboardWriteMatchesFixture", writeMatches);
            requireClipboardGesture(write);
            require(write.optBoolean("succeeded") && writeMatches, "ERR_CLIPBOARD_WRITE_AFTER_TRUSTED_TAP");
            ui(() -> { clipboard.setPrimaryClip(ClipData.newPlainText("LocalTavern QA", sentinel)); return null; });

            if (allowClipboardConsent) {
                startClipboardOperation("read");
                respondClipboardConsent(false);
                JSONObject denied = finishClipboardOperation();
                report.put("clipboardDenyTrustedTap", denied.optBoolean("trusted"));
                report.put("clipboardDenyDocumentFocused", denied.optBoolean("focused"));
                report.put("clipboardDenyUserActivation", denied.optBoolean("activation"));
                report.put("clipboardDenyErrorName", denied.optString("error"));
                boolean rejected = !denied.optBoolean("succeeded") && "NotAllowedError".equals(denied.optString("error"));
                report.put("clipboardDenyRejected", rejected);
                boolean unchanged = clipboardMatchesFixture(sentinel);
                report.put("clipboardUnchangedAfterDeny", unchanged);
                requireClipboardGesture(denied);
                require(rejected && unchanged, "ERR_CLIPBOARD_DENY_CONTRACT");
            }
            startClipboardOperation("read");
            if (allowClipboardConsent) respondClipboardConsent(true);
            JSONObject clip = finishClipboardOperation();
            report.put("clipboardReadSupported", clip.optBoolean("supported"));
            report.put("clipboardTrustedTap", clip.optBoolean("trusted"));
            report.put("clipboardDocumentFocused", clip.optBoolean("focused"));
            report.put("clipboardUserActivation", clip.optBoolean("activation"));
            report.put("clipboardReadMatchesFixture", clip.optBoolean("matches"));
            report.put("clipboardErrorName", clip.optString("error"));
            requireClipboardGesture(clip);
            require(clip.optBoolean("matches"), "ERR_CLIPBOARD_READ_AFTER_TRUSTED_TAP");
        } catch (Failure failure) { error = failure.code; }
        catch (Throwable failure) { error = "ERR_TEST_INFRASTRUCTURE"; }
        finally {
            if (allowClipboardConsent && automation != null) {
                try { reportValue("clipboardConsentCleanupComplete", cancelPendingClipboardConsent()); }
                catch (Throwable failure) { reportValue("clipboardConsentCleanupComplete", false); error = "ERR_CLIPBOARD_DIALOG_CLEANUP"; }
            }
            if (changedClipboard && capturedClipboard) {
                try {
                    ui(() -> { if (previousClip == null) clipboard.clearPrimaryClip(); else clipboard.setPrimaryClip(previousClip); return null; });
                    waitForClipboardForeground();
                    reportValue("guestClipboardRestored", ui(() -> samePlainText(previousClip, clipboard.getPrimaryClip())));
                } catch (Throwable failure) { reportValue("guestClipboardRestored", false); error = "ERR_CLIPBOARD_RESTORE"; }
            } else reportValue("guestClipboardRestored", true);
            if (capturedPage) {
                try {
                    JSONObject restored = evaluate("(()=>{const s=window[" + quote(key) + "];if(!s)return{restored:false};s.disposed=true;"
                        + "s.button?.remove();s.area.removeEventListener('pointerdown',s.tap);if(s.input)s.area.removeEventListener('input',s.input);"
                        + "s.area.value=s.originalDraft;s.area.dispatchEvent(new Event('input',{bubbles:true}));"
                        + "s.area.setSelectionRange(s.originalStart,s.originalEnd);if(s.originalActive?.isConnected)s.originalActive.focus();"
                        + "scrollTo(s.scrollX,s.scrollY);if(document.querySelector('#chat')&&s.chatScroll!==undefined)document.querySelector('#chat').scrollTop=s.chatScroll;"
                        + "const restored=s.area.value===s.originalDraft;delete window[" + quote(key) + "];return{restored};})()");
                    reportValue("draftRestored", restored.optBoolean("restored"));
                    ui(() -> {
                        if (previousNativeFocus != null && previousNativeFocus.isAttachedToWindow()) previousNativeFocus.requestFocus();
                        else web.clearFocus();
                        InputMethodManager ime = activity.getSystemService(InputMethodManager.class);
                        if (!previousIme) ime.hideSoftInputFromWindow(web.getWindowToken(), 0);
                        else if (previousNativeFocus != null) ime.showSoftInput(previousNativeFocus, InputMethodManager.SHOW_FORCED);
                        return null;
                    });
                    long keyboardDeadline = SystemClock.uptimeMillis() + 2500;
                    while (imeVisible() != previousIme && SystemClock.uptimeMillis() < keyboardDeadline) SystemClock.sleep(50);
                    boolean keyboardRestored = imeVisible() == previousIme;
                    reportValue("imeStateRestored", keyboardRestored);
                    if (!keyboardRestored) error = "ERR_IME_RESTORE";
                } catch (Throwable failure) { reportValue("draftRestored", false); error = "ERR_PAGE_RESTORE"; }
            } else if (web != null) {
                try { evaluate("(()=>{delete window[" + quote(key) + "];return{ok:true};})()"); } catch (Throwable ignored) {}
            }
            if (automation != null && previousAccessibilityFlags != null) {
                try { AccessibilityServiceInfo info = automation.getServiceInfo(); info.flags = previousAccessibilityFlags; automation.setServiceInfo(info); }
                catch (Throwable ignored) {}
            }
            reportValue("passed", error.isEmpty() && report.optBoolean("guestClipboardRestored") && report.optBoolean("draftRestored"));
            try { report.put("errorCode", error); report.put("phase", phase); } catch (Exception ignored) {}
            Bundle results = new Bundle(); results.putString("report_json", report.toString());
            finish(report.optBoolean("passed") ? Activity.RESULT_OK : Activity.RESULT_CANCELED, results);
        }
    }

    private void startClipboardOperation(String operation) throws Exception {
        require("read".equals(operation) || "write".equals(operation), "ERR_TEST_OPERATION");
        evaluate("(()=>{const s=window[" + quote(key) + "];s.clipboardOperation=" + quote(operation) + ";"
            + "s.clipboardDone=false;s.clipboardMatches=false;s.clipboardSucceeded=false;s.clipboardError='';"
            + "s.clipboardTrusted=false;s.clipboardFocused=false;s.clipboardActivation=false;s.clipboardSupported=false;return{ok:true};})()");
        tap("window[" + quote(key) + "].button");
    }
    private JSONObject finishClipboardOperation() throws Exception {
        waitUntil(9500, () -> evaluate("(()=>({done:window[" + quote(key) + "].clipboardDone===true}))()").optBoolean("done"), "ERR_CLIPBOARD_TIMEOUT");
        return evaluate("(()=>{const s=window[" + quote(key) + "];return{trusted:s.clipboardTrusted===true,focused:s.clipboardFocused===true,"
            + "activation:s.clipboardActivation===true,supported:s.clipboardSupported===true,succeeded:s.clipboardSucceeded===true,"
            + "matches:s.clipboardMatches===true,error:s.clipboardError||''};})()");
    }
    private static void requireClipboardGesture(JSONObject state) throws Failure {
        require(state.optBoolean("trusted") && state.optBoolean("focused") && state.optBoolean("activation"), "ERR_CLIPBOARD_GESTURE_CONTEXT");
    }
    private boolean clipboardMatchesFixture(String expected) throws Exception {
        // Native clipboard reads are confined to the foreground owned app and
        // compare to this run's known fixture without returning the clip text.
        waitForClipboardForeground();
        return ui(() -> {
            ClipData current = clipboard.getPrimaryClip();
            return current != null && current.getItemCount() == 1 && current.getItemAt(0).getText() != null
                && expected.contentEquals(current.getItemAt(0).getText());
        });
    }
    private void waitForClipboardForeground() throws Exception {
        waitUntil(3000, () -> ui(() -> web.hasWindowFocus())
            && evaluate("(()=>({focused:document.hasFocus()}))()").optBoolean("focused"), "ERR_CLIPBOARD_APP_NOT_FOREGROUND");
    }
    private void ensureAutomation() {
        if (automation != null) return;
        automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        AccessibilityServiceInfo info = automation.getServiceInfo();
        previousAccessibilityFlags = info.flags;
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        automation.setServiceInfo(info);
    }
    private void respondClipboardConsent(boolean allow) throws Exception {
        ensureAutomation();
        long deadline = SystemClock.uptimeMillis() + 5000;
        while (SystemClock.uptimeMillis() < deadline) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            try {
                AccessibilityNodeInfo button = expectedClipboardConsentButton(root, allow);
                if (button != null) {
                    String prefix = allow ? "clipboardAllow" : "clipboardDeny";
                    report.put(prefix + "DialogVerified", true);
                    boolean clicked = button.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    report.put(prefix + "ActionPerformed", clicked);
                    require(clicked, "ERR_CLIPBOARD_CONSENT_ACTION");
                    return;
                }
            } finally { if (root != null) root.recycle(); }
            SystemClock.sleep(80);
        }
        throw new Failure("ERR_EXPECTED_CLIPBOARD_CONSENT_DIALOG");
    }
    private boolean cancelPendingClipboardConsent() throws Exception {
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        boolean cancelled = false;
        try {
            AccessibilityNodeInfo button = expectedClipboardConsentButton(root, false);
            if (button == null) return true;
            cancelled = button.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        } finally { if (root != null) root.recycle(); }
        if (!cancelled) return false;
        waitUntil(3000, () -> {
            AccessibilityNodeInfo next = automation.getRootInActiveWindow();
            try { return expectedClipboardConsentButton(next, false) == null; }
            finally { if (next != null) next.recycle(); }
        }, "ERR_CLIPBOARD_DIALOG_CLEANUP");
        return true;
    }
    private static AccessibilityNodeInfo expectedClipboardConsentButton(AccessibilityNodeInfo root, boolean allow) {
        if (root == null || !TARGET.contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) return null;
        List<AccessibilityNodeInfo> titles = root.findAccessibilityNodeInfosByViewId("android:id/alertTitle");
        List<AccessibilityNodeInfo> messages = root.findAccessibilityNodeInfosByViewId("android:id/message");
        List<AccessibilityNodeInfo> positive = root.findAccessibilityNodeInfosByViewId("android:id/button1");
        List<AccessibilityNodeInfo> negative = root.findAccessibilityNodeInfosByViewId("android:id/button2");
        if (titles.size() != 1 || messages.size() != 1 || positive.size() != 1 || negative.size() != 1) return null;
        if (!expectedNativeNode(titles.get(0), CLIPBOARD_TITLE, false) || !expectedNativeNode(messages.get(0), CLIPBOARD_MESSAGE, false)
            || !expectedNativeNode(positive.get(0), "允许", true) || !expectedNativeNode(negative.get(0), "取消", true)) return null;
        return (allow ? positive : negative).get(0);
    }
    private static boolean expectedNativeNode(AccessibilityNodeInfo node, String text, boolean button) {
        return node.isVisibleToUser() && node.isEnabled()
            && TARGET.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())
            && text.contentEquals(node.getText() == null ? "" : node.getText())
            && (!button || (node.isClickable() && "android.widget.Button".contentEquals(node.getClassName() == null ? "" : node.getClassName())));
    }
    private static String quote(String value) { return JSONObject.quote(value); }
    private void waitForInteractionReady(long deadline) throws Exception {
        // Upstream records completion of APP_READY, including when the test
        // attaches after that event. Never mistake DOM existence for readiness.
        evaluate("(()=>{const s=window[" + quote(key) + "]={modulesReady:false};"
            + "Promise.all([import(" + quote(ORIGIN + "/script.js") + "),import(" + quote(ORIGIN + "/scripts/action-loader.js") + ")]).then(([m,l])=>{"
            + "s.script=m;s.loader=l.loader;s.modulesReady=true;"
            + "}).catch(error=>{s.modulesFailed=true;s.importTypeError=error?.name==='TypeError';"
            + "s.importSyntaxError=error?.name==='SyntaxError';s.importSecurityError=error?.name==='SecurityError';"
            + "s.importNetworkError=error?.name==='NetworkError';s.importOtherError=!s.importTypeError&&!s.importSyntaxError&&!s.importSecurityError&&!s.importNetworkError;"
            + "});return{started:true};})()");
        report.put("blockingDialogObservedDuringSetup", false);
        report.put("knownOnboardingPresent", false);
        report.put("onboardingCompletedByTest", false);
        long stableSince = 0, onboardingClickedAt = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            JSONObject state = evaluate("(()=>{const s=window[" + quote(key) + "];if(!s?.modulesReady)return{modulesReady:false,modulesFailed:s?.modulesFailed===true,"
                + "importTypeError:s?.importTypeError===true,importSyntaxError:s?.importSyntaxError===true,importSecurityError:s?.importSecurityError===true,"
                + "importNetworkError:s?.importNetworkError===true,importOtherError:s?.importOtherError===true};"
                + "const all=[...document.querySelectorAll('dialog[open]:not([closing])')];"
                + "const onboard=all.filter(d=>d.querySelector('.onboarding #onboarding-UI-language-block')&&d.querySelector('.onboarding #onboarding_ui_language_select')&&d.querySelector('.popup-button-ok'));"
                + "const unknown=all.filter(d=>!onboard.includes(d)&&!d.querySelector('.splash-screen,#loader'));"
                + "const a=document.querySelector('#send_textarea'),r=a?.getBoundingClientRect();"
                + "const hit=r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2):null;"
                // The sticky record is written after APP_READY listeners finish,
                // and also covers a listener registered during an ongoing emit.
                + "return{modulesReady:true,appReady:s.script.eventSource.autoFireLastArgs?.has(s.script.event_types.APP_READY)===true,settingsReady:s.script.settingsReady===true,"
                + "generating:s.script.isGenerating(),saving:s.script.isChatSaving,editing:Boolean(document.querySelector('#curEditTextarea')),"
                + "dialogCount:all.length,onboarding:onboard.length===1,unknownModal:unknown.length>0,loaderBlocking:s.loader.isBlocking(),"
                + "inputReady:Boolean(a&&!a.disabled&&!a.readOnly&&r.width>0&&r.height>0&&(hit===a||a.contains(hit)))"
                + "&&location.origin===" + quote(ORIGIN) + "&&document.visibilityState==='visible'};})()");
            if (state.optBoolean("modulesFailed")) {
                for (String name : new String[]{"importTypeError", "importSyntaxError", "importSecurityError", "importNetworkError", "importOtherError"}) report.put(name, state.optBoolean(name));
                throw new Failure("ERR_STATE_GUARD_NOT_READY");
            }
            if (state.optBoolean("modulesReady")) {
                report.put("appReadyObserved", state.optBoolean("appReady"));
                report.put("settingsReadyObserved", state.optBoolean("settingsReady"));
                report.put("loaderBlockingDuringSetup", state.optBoolean("loaderBlocking"));
                report.put("inputReadyDuringSetup", state.optBoolean("inputReady"));
                require(!state.optBoolean("generating") && !state.optBoolean("editing"), "ERR_ACTIVE_GENERATION_OR_EDIT");
                if (state.optInt("dialogCount") > 0) report.put("blockingDialogObservedDuringSetup", true);
                require(!state.optBoolean("unknownModal"), "ERR_UNKNOWN_MODAL_SETUP_REQUIRED");
                if (state.optBoolean("onboarding")) {
                    report.put("knownOnboardingPresent", true); stableSince = 0;
                    require(allowOnboarding, "ERR_FIRST_RUN_OR_MODAL_SETUP_REQUIRED");
                    // Exactly one native activation. Subsequent probes only
                    // observe its completion; they never accept another dialog.
                    if (onboardingClickedAt == 0 && !state.optBoolean("saving")) {
                        tap("document.querySelector('dialog[open]:not([closing]) .onboarding').closest('dialog').querySelector('.popup-button-ok')");
                        onboardingClickedAt = SystemClock.uptimeMillis();
                    } else if (onboardingClickedAt != 0 && SystemClock.uptimeMillis() - onboardingClickedAt > 8000) {
                        throw new Failure("ERR_ONBOARDING_NOT_COMPLETED");
                    }
                } else {
                    if (onboardingClickedAt != 0) report.put("onboardingCompletedByTest", true);
                    boolean ready = state.optBoolean("appReady") && state.optBoolean("settingsReady")
                        && !state.optBoolean("loaderBlocking") && state.optInt("dialogCount") == 0
                        && !state.optBoolean("saving") && state.optBoolean("inputReady");
                    if (ready) {
                        if (stableSince == 0) stableSince = SystemClock.uptimeMillis();
                        if (SystemClock.uptimeMillis() - stableSince >= 300) {
                            report.put("appReadyObserved", true); report.put("settingsReadyObserved", true);
                            report.put("unobstructedStableMs", SystemClock.uptimeMillis() - stableSince);
                            report.put("noActiveGenerationOrEditor", true); return;
                        }
                    } else stableSince = 0;
                }
            }
            SystemClock.sleep(80);
        }
        throw new Failure("ERR_UNOBSTRUCTED_APP_NOT_READY");
    }
    private void reportValue(String key, boolean value) { try { report.put(key, value); } catch (Exception ignored) {} }
    private static void require(boolean value, String code) throws Failure { if (!value) throw new Failure(code); }
    private static final class Failure extends Exception { final String code; Failure(String code) { this.code = code; } }
    private interface Probe { boolean get() throws Exception; }
    private static void waitUntil(long timeout, Probe probe, String code) throws Exception {
        long end = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < end) { if (probe.get()) return; SystemClock.sleep(80); }
        throw new Failure(code);
    }
    private <T> T ui(Callable<T> task) throws Exception {
        CountDownLatch complete = new CountDownLatch(1);
        AtomicReference<T> value = new AtomicReference<>(); AtomicReference<Throwable> failure = new AtomicReference<>();
        main.post(() -> { try { value.set(task.call()); } catch (Throwable error) { failure.set(error); } finally { complete.countDown(); } });
        if (!complete.await(10, TimeUnit.SECONDS) || failure.get() != null) throw new Failure("ERR_MAIN_THREAD_OPERATION");
        return value.get();
    }
    private JSONObject evaluate(String expression) throws Exception {
        CountDownLatch complete = new CountDownLatch(1); AtomicReference<String> value = new AtomicReference<>();
        ui(() -> { web.evaluateJavascript("JSON.stringify(" + expression + ")", result -> { value.set(result); complete.countDown(); }); return null; });
        if (!complete.await(10, TimeUnit.SECONDS)) throw new Failure("ERR_WEBVIEW_CALLBACK_TIMEOUT");
        Object decoded = new JSONTokener(value.get() == null ? "null" : value.get()).nextValue();
        if (!(decoded instanceof String)) throw new Failure("ERR_WEBVIEW_TEST_EXPRESSION");
        return new JSONObject((String)decoded);
    }
    private boolean imeVisible() throws Exception {
        return ui(() -> { WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets(); return insets != null && insets.isVisible(WindowInsets.Type.ime()); });
    }
    private void tap(String element) throws Exception {
        JSONObject rect = evaluate("(()=>{const e=" + element + ";if(!e)return{ok:false};const r=e.getBoundingClientRect();return{ok:r.width>0&&r.height>0,x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth,height:innerHeight};})()");
        require(rect.optBoolean("ok"), "ERR_TAP_TARGET_MISSING");
        float[] point = ui(() -> {
            int[] position = new int[2]; web.getLocationOnScreen(position);
            report.put("nativeWebViewX", position[0]); report.put("nativeWebViewY", position[1]);
            report.put("nativeWebViewWidth", web.getWidth()); report.put("nativeWebViewHeight", web.getHeight());
            report.put("cssViewportWidth", rect.getDouble("width")); report.put("cssViewportHeight", rect.getDouble("height"));
            return new float[]{position[0] + (float)(rect.getDouble("x") * web.getWidth() / rect.getDouble("width")),
                position[1] + (float)(rect.getDouble("y") * web.getHeight() / rect.getDouble("height"))};
        });
        report.put("nativeTapX", point[0]); report.put("nativeTapY", point[1]);
        long time = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, point[0], point[1], 0);
        MotionEvent up = null;
        try {
            down.setSource(InputDevice.SOURCE_TOUCHSCREEN); sendPointerSync(down); SystemClock.sleep(80);
            up = MotionEvent.obtain(time, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, point[0], point[1], 0);
            up.setSource(InputDevice.SOURCE_TOUCHSCREEN); sendPointerSync(up);
        } finally { down.recycle(); if (up != null) up.recycle(); }
    }
    private static boolean isPlainText(ClipData value) {
        if (value == null) return true;
        for (int i = 0; i < value.getItemCount(); i++) if (value.getItemAt(i).getUri() != null
            || value.getItemAt(i).getIntent() != null || value.getItemAt(i).getText() == null) return false;
        return true;
    }
    private static boolean samePlainText(ClipData before, ClipData after) {
        if (before == null || after == null) return before == after;
        if (before.getItemCount() != after.getItemCount()) return false;
        for (int i = 0; i < before.getItemCount(); i++) if (!String.valueOf(before.getItemAt(i).getText()).equals(String.valueOf(after.getItemAt(i).getText()))) return false;
        return true;
    }
}
