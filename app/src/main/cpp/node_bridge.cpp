#include <jni.h>
#include <node.h>
#include <android/log.h>

#include <atomic>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

namespace {
std::atomic<bool> started{false};
constexpr const char* TAG = "LocalTavernNode";

class JavaString {
 public:
  JavaString(JNIEnv* env, jstring string) : env_(env), string_(string) {
    chars_ = string ? env->GetStringUTFChars(string, nullptr) : nullptr;
  }
  ~JavaString() {
    if (chars_) env_->ReleaseStringUTFChars(string_, chars_);
  }
  bool valid() const { return chars_ != nullptr; }
  std::string value() const { return chars_ ? chars_ : ""; }

 private:
  JNIEnv* env_;
  jstring string_;
  const char* chars_ = nullptr;
};

bool environment(const char* name, const std::string& value) {
  if (setenv(name, value.c_str(), 1) == 0) return true;
  __android_log_print(ANDROID_LOG_ERROR, TAG, "Cannot set %s: errno %d", name, errno);
  return false;
}
}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_app_local_tavern_NodeBridge_start(JNIEnv* env, jclass, jstring root_value,
                                     jstring data_value, jstring cache_value,
                                     jstring log_value, jint port) {
  // node::Start is process-global and cannot safely be called again. The host
  // puts this library in its dedicated :runtime process and restarts that
  // process when a new Node instance is required.
  if (started.exchange(true)) return -100;
  JavaString root_java(env, root_value), data_java(env, data_value);
  JavaString cache_java(env, cache_value), log_java(env, log_value);
  if (!root_java.valid() || !data_java.valid() || !cache_java.valid() || !log_java.valid()) {
    return -101;
  }
  if (port < 1024 || port > 65535) return -102;
  const std::filesystem::path root(root_java.value());
  const std::filesystem::path data(data_java.value());
  const std::filesystem::path cache(cache_java.value());
  try {
    std::filesystem::create_directories(data);
    std::filesystem::create_directories(cache / "tmp");
    std::filesystem::create_directories(cache / "node-compile");
    if (!std::filesystem::is_regular_file(root / "android-entry.mjs")) return -103;
  } catch (const std::exception& error) {
    __android_log_print(ANDROID_LOG_ERROR, TAG, "Runtime directories: %s", error.what());
    return -104;
  }
  if (chdir(root.c_str()) != 0) return -105;
  if (!environment("TMPDIR", (cache / "tmp").string()) ||
      !environment("HOME", data.string()) ||
      !environment("NODE_COMPILE_CACHE", (cache / "node-compile").string()) ||
      !environment("NODE_COMPILE_CACHE_PORTABLE", "1")) return -106;

  const int output = open(log_java.value().c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (output < 0) return -107;
  const bool redirected = dup2(output, STDOUT_FILENO) >= 0 && dup2(output, STDERR_FILENO) >= 0;
  if (output != STDOUT_FILENO && output != STDERR_FILENO) close(output);
  if (!redirected) return -108;
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);

  std::vector<std::string> arguments{
      "node", "--max-old-space-size=384", (root / "android-entry.mjs").string(),
      "--port", std::to_string(port), "--dataRoot", data.string()};
  // Keep argv in one writable allocation, matching Node's native embedding
  // samples and the process-title/argument handling expected by libuv.
  size_t storage_size = 0;
  for (const auto& argument : arguments) storage_size += argument.size() + 1;
  std::vector<char> storage(storage_size);
  std::vector<char*> argv;
  argv.reserve(arguments.size() + 1);
  size_t offset = 0;
  for (const auto& argument : arguments) {
    argv.push_back(storage.data() + offset);
    std::memcpy(storage.data() + offset, argument.c_str(), argument.size() + 1);
    offset += argument.size() + 1;
  }
  argv.push_back(nullptr);
  __android_log_print(ANDROID_LOG_INFO, TAG, "Starting embedded Node.js on loopback port %d", port);
  const int result = node::Start(static_cast<int>(arguments.size()), argv.data());
  __android_log_print(ANDROID_LOG_INFO, TAG, "Embedded Node.js returned %d", result);
  return result;
}
