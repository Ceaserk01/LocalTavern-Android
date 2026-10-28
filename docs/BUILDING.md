# 构建、测试和发布

仓库包含安卓壳、JNI 启动代码、上游适配补丁及完整构建步骤。APK 打包的 SillyTavern 提交由 `upstream.lock.json` 固定，Node 移动运行时的版本与 SHA-256 由 `scripts/prepare_runtime.py` 固定。构建时下载依赖，安装完成的 App 无需再在线安装酒馆。

## 本地环境

| 工具 | 版本 |
| --- | --- |
| JDK | 17 |
| Node.js | 22，酒馆要求至少 20 |
| Python | 3.9 或更高 |
| Gradle | Wrapper 固定 8.11.1，带发行包 SHA-256 校验 |
| Android SDK | Platform 35、Build Tools 35.0.0 |
| Android NDK | 27.2.12479018 |
| CMake | 3.22.1 |

还需 Git、curl 和可访问依赖服务器的网络。设置 `JAVA_HOME`、`ANDROID_HOME`。可通过 Android Studio 的 SDK Manager 安装上述安卓组件；Linux 命令行也可使用：

```sh
sdkmanager 'platforms;android-35' 'build-tools;35.0.0' \
  'ndk;27.2.12479018' 'cmake;3.22.1'
```

## 首次准备和本地测试

在仓库根目录执行：

```sh
python3 scripts/prepare_runtime.py
node scripts/prepare_bundle.mjs
npm test
./scripts/test_archive.sh
./scripts/test_runtime_storage.sh
./scripts/test_backup.sh
npm run test:integration
./scripts/build.sh --skip-prepare
```

准备步骤检查固定的源码提交、运行时摘要、ABI 与 16 KB 页面对齐；使用上游 `package-lock.json` 执行 `npm ci`，在临时目录应用补丁并预编译前端。ZIP 安全测试实际流式生成和拒绝 512 MiB + 1 字节输入，需预留临时磁盘空间。

`build.sh` 生成开发调试签名的 APK，用于本地测试。正式分发使用下面的发布步骤。重新准备时，原上游检出目录中的已跟踪文件必须与固定提交一致；修改适配层应放在 `runtime/`，避免将本机改动偷偷混入发行资源。

## 生成正式签名的测试发行版

`release.json` 记录应用和发行版本。发布前检查版本、验证记录以及 `upstream.lock.json` 的来源。按 `scripts/release.sh` 的要求配置：

| 环境变量 | 内容 |
| --- | --- |
| `TAVERN_KEYSTORE_FILE` | 签名 keystore 的绝对路径 |
| `TAVERN_KEYSTORE_PASSWORD` | keystore 密码 |
| `TAVERN_KEY_ALIAS` | 签名密钥别名 |
| `TAVERN_KEY_PASSWORD` | 密钥密码 |

通过本机密码管理器、受保护的环境或仓库外配置注入值。不要把密码、keystore、签名配置文件或用户聊天数据提交到公开仓库，也不要开启 shell 的 `set -x` 输出秘密。后续升级需保持相同的 applicationId 和签名密钥，并递增 versionCode。

准备完资源后运行：

```sh
./scripts/release.sh --skip-prepare
```

首次从开发调试签名转到正式签名时，Android 不能直接覆盖安装。先通过 App 导出备份，再按发行说明安装正式签名版本并恢复。相同正式签名的后续版本可覆盖升级。

公开 Release 应包含签名的 ARM64 / x86_64 APK、对应完整源码和 SHA-256 校验和，并注明已验证范围及外部服务 / 原生插件兼容限制。验证签名、安装启动及核心数据读写后再发布；保存签名密钥的离线备份。上传 GitHub Release 是维护者的单独操作，CI 不会自动创建公开发行版。

## GitHub Actions

`.github/workflows/android.yml` 在 main 分支推送、PR、版本标签和手动触发时运行。它使用最小 `contents: read` 权限，不接收签名密钥，也不创建 Release。

流程安装固定安卓工具链，下载并校验运行时，打包完整上游，执行 Git / ZIP / 实际后端测试，然后编译两种 ABI 的 Release 变体并运行 Lint。下载到的 `android-release-unsigned-*` 工件包含 **未签名 APK**、完整源码、摘要和来源元数据，不能直接作为安装包发布。正式可安装包以维护者发布的签名 Release 附件为准。

外部 Actions 均固定到实际核对过的 Git 提交。升级 Action、NDK、Node 移动运行时或上游酒馆时，应同时检查来源、对应补丁和真实安卓运行结果；CI 主机测试不能替代实体手机或模拟器验证。
