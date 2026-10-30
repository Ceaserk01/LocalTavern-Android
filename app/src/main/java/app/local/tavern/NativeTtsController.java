package app.local.tavern;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** A document-scoped port, exposing speech only, to the bundled local page. */
final class NativeTtsController {
    private static final int MAX_TEXT = 131072;
    private static final int MAX_MESSAGE = MAX_TEXT * 6 + 4096;
    private final Context context;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Voice> voices = new HashMap<>();
    private WebMessagePort port;
    private String session;
    private TextToSpeech engine;
    private Voice defaultVoice;
    private boolean initializing, initialized, failed, destroyed;
    private long generation, segmentSequence;
    private Speech current;

    private static final class Speech {
        int id, offset, segmentStart, segmentEnd, resumeOffset;
        String text, token;
        float volume;
        long startedAt;
        boolean started, paused, resuming;
    }

    NativeTtsController(Context context) { this.context = context.getApplicationContext(); }

    void attach(WebView view) {
        if (destroyed || port != null) return;
        final long boundGeneration = ++generation;
        session = UUID.randomUUID().toString();
        WebMessagePort[] channel = view.createWebMessageChannel();
        port = channel[0];
        final WebMessagePort boundPort = port;
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort receiving, WebMessage message) {
                if (destroyed || generation != boundGeneration || port != boundPort) return;
                receive(message.getData());
            }
        });
        try {
            JSONObject hello = new JSONObject().put("type", "local-tavern-tts").put("version", 1).put("session", session);
            view.postWebMessage(new WebMessage(hello.toString(), new WebMessagePort[]{channel[1]}), Uri.parse(RuntimeContract.ORIGIN));
        } catch (Exception error) {
            channel[1].close();
            detach();
        }
    }

    void detach() {
        generation++;
        stopCurrent();
        if (port != null) port.close();
        port = null; session = null;
        // Keep a successfully initialized engine warm across document reloads.
        if (failed) {
            if (engine != null) engine.shutdown();
            engine = null; initialized = false; initializing = false; failed = false;
        }
    }

    void destroy() {
        if (destroyed) return;
        detach(); destroyed = true;
        if (engine != null) engine.shutdown();
        engine = null; voices.clear(); defaultVoice = null;
    }

    private void ensureEngine() {
        if (destroyed) return;
        if (initialized) { publishVoices(); return; }
        if (failed) { unavailable(); return; }
        if (initializing) return;
        initializing = true;
        try {
            engine = new TextToSpeech(context, status -> ui.post(() -> {
                if (destroyed) return;
                initializing = false;
                if (status != TextToSpeech.SUCCESS || engine == null) { failed = true; unavailable(); return; }
                try {
                    defaultVoice = engine.getDefaultVoice();
                    engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String token) { ui.post(() -> started(token)); }
                    @Override public void onDone(String token) { ui.post(() -> completed(token)); }
                    @Override public void onError(String token) { onError(token, TextToSpeech.ERROR_SYNTHESIS); }
                    @Override public void onError(String token, int code) { ui.post(() -> failed(token, code)); }
                    @Override public void onRangeStart(String token, int start, int end, int frame) {
                        ui.post(() -> boundary(token, start, end));
                    }
                    });
                    initialized = true;
                    publishVoices();
                } catch (Exception error) { initialized = false; failed = true; unavailable(); }
            }));
        } catch (Exception error) { initializing = false; failed = true; unavailable(); }
    }

    private void receive(String data) {
        if (data == null || data.length() > MAX_MESSAGE) return;
        try {
            JSONObject value = new JSONObject(data);
            if (!session.equals(value.optString("session"))) return;
            String type = value.optString("type");
            if (type.equals("voices")) { ensureEngine(); return; }
            if (type.equals("cancel")) { stopCurrent(); return; }
            Object rawId = value.opt("id");
            if (!(rawId instanceof Number)) return;
            double idValue = ((Number)rawId).doubleValue();
            if (!Double.isFinite(idValue) || idValue < 1 || idValue > Integer.MAX_VALUE || idValue != Math.floor(idValue)) return;
            int id = (int)idValue;
            if (type.equals("speak")) speak(id, value);
            else if (current != null && current.id == id) {
                if (type.equals("pause")) pause();
                else if (type.equals("resume")) resume();
            }
        } catch (Exception ignored) { /* Invalid messages cannot reach Android services. */ }
    }

    private void publishVoices() {
        if (!initialized || engine == null) return;
        try {
            Set<Voice> available = engine.getVoices();
            voices.clear();
            ArrayList<Voice> ordered = new ArrayList<>();
            if (available != null) ordered.addAll(available);
            if (ordered.size() > 4096) { unavailable(); return; }
            ordered.sort(Comparator.comparing(v -> v.getName() == null ? "" : v.getName()));
            JSONArray list = new JSONArray();
            for (Voice voice : ordered) {
                String name = voice.getName();
                if (name == null || name.length() > 512 || voice.getLocale() == null) continue;
                String uri = "android:" + engine.getDefaultEngine() + ":" + name;
                if (uri.length() > 1024) continue;
                voices.put(uri, voice);
                list.put(new JSONObject().put("name", name).put("voiceURI", uri).put("lang", voice.getLocale().toLanguageTag())
                    .put("localService", !voice.isNetworkConnectionRequired()).put("default", voice.equals(defaultVoice)));
            }
            send(new JSONObject().put("type", "voices").put("voices", list));
        } catch (Exception error) { unavailable(); }
    }

    private void unavailable() {
        try { send(new JSONObject().put("type", "unavailable")); } catch (Exception ignored) {}
    }

    private void speak(int id, JSONObject value) {
        try {
            if (current != null) { event(id, "error", 0, 0, 0, "audio-busy"); return; }
            if (!initialized || engine == null || failed) { event(id, "error", 0, 0, 0, "synthesis-unavailable"); return; }
            if (!(value.opt("text") instanceof String) || !(value.opt("lang") instanceof String) || !(value.opt("voice") instanceof String)) {
                event(id, "error", 0, 0, 0, "invalid-argument"); return;
            }
            String text = value.getString("text"), lang = value.getString("lang"), voiceUri = value.getString("voice");
            if (text.length() > MAX_TEXT) { event(id, "error", 0, 0, 0, "text-too-long"); return; }
            if (lang.length() > 128 || voiceUri.length() > 1024) { event(id, "error", 0, 0, 0, "invalid-argument"); return; }
            float volume = number(value, "volume", 0, 1), rate = number(value, "rate", 0.1, 10), pitch = number(value, "pitch", 0, 2);
            if (!voiceUri.isEmpty()) {
                Voice chosen = voices.get(voiceUri);
                if (chosen == null || engine.setVoice(chosen) != TextToSpeech.SUCCESS) {
                    event(id, "error", 0, 0, 0, "voice-unavailable"); return;
                }
            } else if (!lang.isEmpty()) {
                Locale locale = Locale.forLanguageTag(lang);
                if (locale.getLanguage().isEmpty() || engine.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
                    event(id, "error", 0, 0, 0, "language-unavailable"); return;
                }
            } else if (defaultVoice != null && engine.setVoice(defaultVoice) != TextToSpeech.SUCCESS) {
                event(id, "error", 0, 0, 0, "voice-unavailable"); return;
            } else if (defaultVoice == null && engine.setLanguage(Locale.getDefault()) < TextToSpeech.LANG_AVAILABLE) {
                event(id, "error", 0, 0, 0, "language-unavailable"); return;
            }
            // Android engines require a positive pitch; zero selects their lowest
            // representable pitch rather than rejecting the Web Speech range.
            if (engine.setSpeechRate(rate) != TextToSpeech.SUCCESS || engine.setPitch(Math.max(0.01f, pitch)) != TextToSpeech.SUCCESS) {
                event(id, "error", 0, 0, 0, "invalid-argument"); return;
            }
            Speech speech = new Speech(); speech.id = id; speech.text = text; speech.volume = volume;
            current = speech;
            if (text.isEmpty()) {
                speech.started = true; speech.startedAt = SystemClock.elapsedRealtime();
                event(id, "start", 0, 0, 0, null); current = null;
                event(id, "end", 0, 0, 0, null); return;
            }
            nextSegment();
        } catch (Exception error) {
            if (current != null && current.id == id) stopCurrent();
            event(id, "error", 0, 0, 0, "invalid-argument");
        }
    }

    private static float number(JSONObject object, String key, double min, double max) throws Exception {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException();
        double number = ((Number)value).doubleValue();
        if (!Double.isFinite(number) || number < min || number > max) throw new IllegalArgumentException();
        return (float)number;
    }

    private void nextSegment() {
        Speech speech = current;
        if (speech == null || speech.paused || engine == null) return;
        if (speech.offset >= speech.text.length()) {
            current = null; event(speech.id, "end", speech.text.length(), 0, elapsed(speech), null); return;
        }
        int limit = Math.max(2, TextToSpeech.getMaxSpeechInputLength() - 1);
        int end = Math.min(speech.text.length(), speech.offset + limit);
        if (end < speech.text.length()) {
            if (Character.isHighSurrogate(speech.text.charAt(end - 1)) && Character.isLowSurrogate(speech.text.charAt(end))) end--;
            int lower = Math.max(speech.offset + (end - speech.offset) / 2, end - 256);
            for (int i = end - 1; i > lower; i--) {
                char c = speech.text.charAt(i);
                if (Character.isWhitespace(c) || ".!?。！？".indexOf(c) >= 0) { end = i + 1; break; }
            }
        }
        speech.segmentStart = speech.offset; speech.segmentEnd = end; speech.resumeOffset = speech.offset;
        speech.token = generation + ":" + speech.id + ":" + (++segmentSequence);
        Bundle parameters = new Bundle(); parameters.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, speech.volume);
        String token = speech.token;
        try {
            int result = engine.speak(speech.text.substring(speech.offset, end), TextToSpeech.QUEUE_FLUSH, parameters, token);
            if (result != TextToSpeech.SUCCESS) failed(token, TextToSpeech.ERROR_SYNTHESIS);
        } catch (Exception error) { failed(token, TextToSpeech.ERROR_SYNTHESIS); }
    }

    private boolean matches(String token) { return current != null && token != null && token.equals(current.token) && !destroyed; }
    private static double elapsed(Speech speech) { return speech.startedAt == 0 ? 0 : (SystemClock.elapsedRealtime() - speech.startedAt) / 1000.0; }
    private void started(String token) {
        if (!matches(token)) return;
        if (!current.started) {
            current.started = true; current.startedAt = SystemClock.elapsedRealtime();
            event(current.id, "start", current.offset, 0, 0, null);
        } else if (current.resuming) {
            current.resuming = false;
            event(current.id, "resume", current.offset, 0, elapsed(current), null);
        }
    }
    private void boundary(String token, int start, int end) {
        if (!matches(token) || current.paused || start < 0 || end < start || end > current.segmentEnd - current.segmentStart) return;
        current.resumeOffset = current.segmentStart + start;
        event(current.id, "boundary", current.resumeOffset, end - start, elapsed(current), null);
    }
    private void completed(String token) {
        if (!matches(token) || current.paused) return;
        current.offset = current.segmentEnd; current.token = null;
        nextSegment();
    }
    private void failed(String token, int code) {
        if (!matches(token)) return;
        Speech speech = current; current = null; speech.token = null;
        event(speech.id, "error", speech.resumeOffset, 0, elapsed(speech), errorName(code));
    }
    private static String errorName(int code) {
        switch (code) {
            case TextToSpeech.ERROR_NETWORK:
            case TextToSpeech.ERROR_NETWORK_TIMEOUT: return "network";
            case TextToSpeech.ERROR_OUTPUT: return "audio-hardware";
            case TextToSpeech.ERROR_NOT_INSTALLED_YET: return "voice-unavailable";
            case TextToSpeech.ERROR_INVALID_REQUEST: return "invalid-argument";
            case TextToSpeech.ERROR_SERVICE: return "synthesis-unavailable";
            default: return "synthesis-failed";
        }
    }
    private void pause() {
        if (current == null || current.paused) return;
        current.paused = true;
        current.token = null; // Ignore the asynchronous onStop/onDone from stop().
        current.offset = current.resumeOffset;
        if (engine != null) try { engine.stop(); } catch (Exception ignored) {}
        event(current.id, "pause", current.offset, 0, elapsed(current), null);
    }
    private void resume() {
        if (current == null || !current.paused) return;
        current.paused = false; current.resuming = current.started;
        // TextToSpeech has no native pause API. Restart from its latest reported
        // range boundary, so an engine without range events can repeat a segment.
        nextSegment();
    }
    private void stopCurrent() {
        if (current != null) current.token = null;
        current = null;
        if (engine != null && initialized) try { engine.stop(); } catch (Exception ignored) {}
    }
    private void event(int id, String kind, int index, int length, double elapsed, String error) {
        try {
            JSONObject value = new JSONObject().put("type", "event").put("id", id).put("event", kind)
                .put("charIndex", index).put("charLength", length).put("elapsedTime", elapsed);
            if (kind.equals("boundary")) value.put("name", "word");
            if (error != null) value.put("error", error);
            send(value);
        } catch (Exception ignored) {}
    }
    private void send(JSONObject value) {
        if (destroyed || port == null || session == null) return;
        try { value.put("session", session); port.postMessage(new WebMessage(value.toString())); }
        catch (Exception error) { detach(); }
    }
}
