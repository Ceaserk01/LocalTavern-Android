#include <jni.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "zstd.h"

#define BUNDLE_BUFFER_SIZE (128U * 1024U)
#define BUNDLE_WINDOW_LOG_MAX 25
#ifndef TAVERN_ZSTD_MAX_OUTPUT
/* SafeZip permits 2 GiB of file data; leave bounded room for ZIP metadata. */
#define TAVERN_ZSTD_MAX_OUTPUT (2ULL * 1024ULL * 1024ULL * 1024ULL + 128ULL * 1024ULL * 1024ULL)
#endif

typedef struct {
    FILE* input;
    ZSTD_DCtx* decoder;
    size_t position;
    size_t available;
    uint64_t decoded;
    int started;
    int finished;
    unsigned char compressed[BUNDLE_BUFFER_SIZE];
    unsigned char output[BUNDLE_BUFFER_SIZE];
} BundleDecoder;

static void fail(JNIEnv* env, const char* message) {
    jclass exception = (*env)->FindClass(env, "java/io/IOException");
    if (exception != NULL) (*env)->ThrowNew(env, exception, message);
}

static void release(BundleDecoder* state) {
    if (state == NULL) return;
    if (state->input != NULL) fclose(state->input);
    ZSTD_freeDCtx(state->decoder);
    free(state);
}

JNIEXPORT jlong JNICALL
Java_app_local_tavern_BundleZstdInputStream_openNative(JNIEnv* env, jclass type, jstring path) {
    (void)type;
    if (path == NULL) { fail(env, "Missing bundled runtime path"); return 0; }
    const char* filename = (*env)->GetStringUTFChars(env, path, NULL);
    if (filename == NULL) return 0;
    FILE* input = fopen(filename, "rb");
    (*env)->ReleaseStringUTFChars(env, path, filename);
    if (input == NULL) { fail(env, "Cannot read bundled runtime archive"); return 0; }
    BundleDecoder* state = calloc(1, sizeof(*state));
    if (state == NULL) {
        fclose(input); fail(env, "Cannot allocate bundled runtime decoder"); return 0;
    }
    state->input = input;
    state->decoder = ZSTD_createDCtx();
    if (state->decoder == NULL) {
        release(state); fail(env, "Cannot allocate Zstandard context"); return 0;
    }
    if (ZSTD_isError(ZSTD_DCtx_setParameter(state->decoder, ZSTD_d_windowLogMax, BUNDLE_WINDOW_LOG_MAX))) {
        release(state); fail(env, "Cannot limit Zstandard decoder window"); return 0;
    }
    return (jlong)(uintptr_t)state;
}

JNIEXPORT jint JNICALL
Java_app_local_tavern_BundleZstdInputStream_readNative(JNIEnv* env, jclass type, jlong handle,
                                                    jbyteArray destination, jint offset, jint length) {
    (void)type;
    BundleDecoder* state = (BundleDecoder*)(uintptr_t)handle;
    if (state == NULL) { fail(env, "Bundled runtime decoder is closed"); return -1; }
    if (destination == NULL) { fail(env, "Missing decoder output buffer"); return -1; }
    jsize array_length = (*env)->GetArrayLength(env, destination);
    if (offset < 0 || length < 0 || offset > array_length - length) {
        fail(env, "Invalid decoder output bounds"); return -1;
    }
    if (length == 0) return 0;
    if (state->finished) return -1;
    size_t capacity = (size_t)length;
    if (capacity > BUNDLE_BUFFER_SIZE) capacity = BUNDLE_BUFFER_SIZE;
    for (;;) {
        if (state->position == state->available) {
            state->available = fread(state->compressed, 1, sizeof(state->compressed), state->input);
            state->position = 0;
            if (ferror(state->input)) { fail(env, "Cannot read compressed bundled runtime"); return -1; }
        }
        if (!state->started) {
            /* Do not accept a skippable frame as the bundled archive. */
            static const unsigned char magic[4] = { 0x28, 0xb5, 0x2f, 0xfd };
            if (state->available < sizeof(magic) || memcmp(state->compressed, magic, sizeof(magic)) != 0) {
                fail(env, "Invalid Zstandard bundle frame"); return -1;
            }
            state->started = 1;
        }
        ZSTD_inBuffer input = { state->compressed, state->available, state->position };
        ZSTD_outBuffer output = { state->output, capacity, 0 };
        size_t previous = input.pos;
        size_t remaining = ZSTD_decompressStream(state->decoder, &output, &input);
        state->position = input.pos;
        if (ZSTD_isError(remaining)) { fail(env, "Invalid or oversized Zstandard bundle"); return -1; }
        if (output.pos > TAVERN_ZSTD_MAX_OUTPUT - state->decoded) {
            fail(env, "Decoded bundled runtime exceeds size limit"); return -1;
        }
        state->decoded += output.pos;
        if (remaining == 0) {
            // Only one frame is accepted, including its checksum. No second
            // frame, skippable frame, or arbitrary trailing byte may be ignored.
            if (input.pos != input.size || fgetc(state->input) != EOF) {
                fail(env, "Trailing data after Zstandard bundle frame"); return -1;
            }
            if (ferror(state->input)) { fail(env, "Cannot verify bundled runtime EOF"); return -1; }
            state->finished = 1;
        } else if (output.pos == 0 && input.pos == previous) {
            fail(env, state->available == 0 ? "Truncated Zstandard bundle frame"
                                           : "Zstandard bundle decoder made no progress");
            return -1;
        }
        if (output.pos != 0) {
            (*env)->SetByteArrayRegion(env, destination, offset, (jsize)output.pos, (const jbyte*)state->output);
            return (*env)->ExceptionCheck(env) ? -1 : (jint)output.pos;
        }
        if (state->finished) return -1;
    }
}

JNIEXPORT void JNICALL
Java_app_local_tavern_BundleZstdInputStream_closeNative(JNIEnv* env, jclass type, jlong handle) {
    (void)env; (void)type;
    release((BundleDecoder*)(uintptr_t)handle);
}
