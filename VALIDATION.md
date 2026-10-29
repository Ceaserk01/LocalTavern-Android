# 本次构建验证

日期：2026-10-29（Asia/Shanghai）。应用版本 0.1.0-alpha.1，上游 SillyTavern 1.19.0。以下保留首个开发包的验证，并列出签名 Release 的复验。

## 已实际通过

| 检查 | 环境与结果 |
| --- | --- |
| Android 构建 | ARM64、x86_64 签名 Release APK 均成功；AGP 8.9.1 / Gradle 8.11.1 / JDK 17 / NDK 27.2 |
| Release 签名 | 独立 RSA-3072 证书，APK v2 / v3 验证通过，非 debuggable；证书 SHA-256 为 `d2b4fe538d483bdea3bc80653f7d0e5fefa806ccd90dac63728a6f7574c3bfbe` |
| Release 核心复验 | 签名 ARM64 包在 Android 35 全新安装后，角色卡 / 世界书 / 聊天 / tokenizer / 模拟模型 API / SSE 再次全部通过 |
| Android Lint | 0 errors、3 warnings：应用所需的 JavaScript、用户可配置的明文 HTTP 兼容、中文字符串国际化提示 |
| APK 对齐 | 两种 APK 均通过 `zipalign -c -P 16 -v 4` |
| Node 库 | 下载 SHA-256、ELF ABI、所有 PT_LOAD 16 KB 对齐校验通过；所需 C++ 符号由随包 NDK STL 提供 |
| 实际安装启动 | Android 35 ARM64 / 4 GB RAM 模拟器安装成功，完整前端在 WebView 显示；日志确认 Node v24.22.1 |
| 手机内后端 | 在实际 APK 内通过角色卡 JSON → PNG 导入与导出、WASM 图像处理、世界书写读、聊天写读、真实 tiktoken 编解码、CSRF 保留 |
| 模型 API | 实际安卓后端访问宿主机模拟 OpenAI 兼容 API，普通回复与 SSE 流式回复通过；没有使用真实付费账号 |
| 安卓扩展 Git 接口 | 24 次真实接口请求，覆盖 Git URL 安装、发现与 JS 加载、版本、更新、分支、分支切换、本地/全局移动及卸载；仓库使用真实 Git smart HTTP |
| 原生扩展 ZIP | 通过 Android 系统文件选择器导入 GitHub 外层目录 ZIP，重载后扩展 JS 在实际 WebView 执行 |
| 原生服务端插件 ZIP | 通过系统文件选择器导入后重启，插件真实 API 返回正确 JSON |
| Blob 文件导出 | 通过系统保存位置界面导出 600,000 字节，分为 128 KB 块，和源数据逐字节一致 |
| 原生备份恢复 | 实际导出约 16 MB / 268 项备份，改动标记后恢复，标记回到原值；聊天文件与备份逐字节一致，扩展和服务端插件恢复后正常运行 |
| 正常退出与重启 | SIGTERM 执行插件退出钩子，其写入标记包含在备份内；恢复后切换新服务 PID，界面正常返回 |
| 开发包覆盖升级 | 首个开发 ARM64 APK 再次 `adb install -r` 成功，原数据标记保持不变；开发签名与公开 Release 签名不同，迁移步骤见 README |
| 主机集成 | 实际打包后的后端另行通过全部核心测试，以及服务端插件加载 npm 依赖和本地/全局扩展发现 |
| ZIP 安全 | 12 项主机检查通过：Unicode / 二进制、路径穿越、Windows 路径、重复路径、覆盖冲突、符号链接逃逸、空包 / 非 ZIP、CRC，以及真实 512 MiB + 1 字节超限解压；Java 堆仅 64 MiB |
| 运行时清理 | 17 项主机断言通过；当前版本就绪前保留旧版本、清理中断安装、保留用户和插件数据、不跟随符号链接 |
| 备份可恢复性 | 14 项主机检查通过，覆盖 2 GiB 总量 / 512 MiB 单文件 / 200,000 项限制、写入中增长、Unicode 聊天和插件二进制往返；预检失败不开启保存位置流 |
| Release 原生复验 | 签名版通过系统文件选择器导出 16,128,964 字节 / 265 项备份，修改标记和聊天后恢复，聊天 SHA-256 相同，插件路由正常；旧运行时 / 中断安装 / 临时 ZIP 被清理，当前资源和用户数据保留 |
| 性能工作负载 | 实际签名 APK 完成 100 张卡、5,000 条消息、20 次 tokenizer 与 500 个 SSE 事件；[完整方法和原始结果](docs/performance/README.md) 区分主机、安卓、缓存状态和模拟器网络影响 |

首次资源校验与解包在本次模拟器约 32 秒，之后复用已解包资源。这是特定模拟器的观察结果，不是实机性能承诺。WASM tokenizer 测试后，本地 Node 服务的 PSS 约 271 MB，不包含 UI 进程和 WebView 渲染进程。

## 复现入口

- `scripts/build.sh --skip-prepare`：编译和 Lint，生成 APK 与校验和。
- `npm test`：真实 Git 兼容层测试。
- `scripts/test_archive.sh`：ZIP 安全测试。
- `scripts/test_runtime_storage.sh`：安装与旧版本清理测试。
- `scripts/test_backup.sh`：导出和恢复容量、流式写入及变化检测测试。
- `node scripts/smoke_server.mjs`：桌面实际后端测试。
- `adb forward tcp:18768 tcp:18766` 后，`TAVERN_TEST_URL=http://127.0.0.1:18768 TAVERN_TEST_API_HOST=10.0.2.2 node scripts/smoke_server.mjs`：安卓实际后端与模拟模型 API。
- 同样转发后 `node scripts/smoke_extensions.mjs`：安卓扩展接口测试。
- `node scripts/prepare_bundle.mjs --verify-source`：检查固定上游来源；源码发行包可在没有 `.git` 时验证逐文件摘要。

## 尚未覆盖

没有在实体手机、Android 8 至 14 各版本或 x86_64 模拟器启动验证。没有逐一验证所有第三方插件、各提供商真实账号、图片生成 / TTS 外部服务、所有语音设备或长期后台省电场景。公开 Release 使用独立签名及第三方 Node mobile 预发布运行时；这是核心功能经过验证的 Alpha 版本，需要继续积累实机兼容结果。
