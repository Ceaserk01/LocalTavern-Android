# 酒馆助手兼容记录

2026-10-30，在签名 LocalTavern Android 0.1.0-alpha.3（versionCode 4）、SillyTavern 1.19.0、Android 35 ARM64 模拟器上验证了官方[酒馆助手 / TavernHelper](https://github.com/N0VI028/JS-Slash-Runner)。插件由原扩展 Git 安装接口获取，运行的是官方未修改的发行脚本；插件没有捆绑进 APK。

| 身份 | 已验证值 |
| --- | --- |
| 版本 | 4.11.3 |
| 提交 | `ecd74c73518f6607387bed95a966fc1e2b8057c7` |
| 分支 | main |
| `dist/index.js` SHA-256 | `73cd44e6f44634642777edacbd358146d173c14abfec6aece73e4d8517e449cb` |

## 安装

1. 打开酒馆原有扩展面板，选择安装扩展。
2. 输入官方 Git URL：`https://github.com/N0VI028/JS-Slash-Runner`。
3. 安装后重新加载酒馆页面，查看「酒馆助手」面板。功能使用方法见[官方文档](https://n0vi028.github.io/JS-Slash-Runner-Doc/)。

Git 安装和更新需要手机能访问 GitHub。插件、角色卡或脚本引用的远程脚本、样式、图片及其他服务仍需对应网络；本机酒馆运行不意味着这些资源全部离线。该版本助手的[消息 iframe 模板](https://github.com/N0VI028/JS-Slash-Runner/blob/ecd74c73518f6607387bed95a966fc1e2b8057c7/src/panel/render/iframe.ts)和[脚本 iframe 模板](https://github.com/N0VI028/JS-Slash-Runner/blob/ecd74c73518f6607387bed95a966fc1e2b8057c7/src/panel/script/iframe.ts)还包含 jsDelivr 域名下的日志脚本引用。

## 本次已验证范围

- 助手全局 API、版本查询和 Vue 面板初始化。
- srcdoc 与 Blob 两种 HTML 消息 iframe：助手 API、酒馆上下文、聊天变量读写、`/pass`、事件往返和 iframe 名称；srcdoc 另验证了按钮回调。
- 助手脚本 iframe：`/pass`、脚本变量往返、脚本 ID 和酒馆上下文。
- 保存聊天后，从实际后端重新读取并核对聊天变量。
- 测试结束后删除自己的角色、备份、扩展及 ADB 转发，重载后核对助手全局对象／面板／iframe 移除、原草稿恢复、设置文件字节保持一致。

[原始 JSON 报告](../performance/alpha3-tavern-helper-qa.json)保留测试范围与清理结果。按钮回调通过脚本 `.click()` 触发，不构成真实触摸或输入法证据；这次测试不访问模型或剪贴板。没有验证所有角色卡、自定义脚本、自动触发器、外部服务、完全离线运行或特定实体手机性能，也没有小米 15 实机结果。

## 开发者复现

先在仓库的忽略目录准备官方固定检出；插件的 `dist/` 已随官方仓库提供，无需重新编译：

```sh
git clone --filter=blob:none https://github.com/N0VI028/JS-Slash-Runner .cache/tavern-helper
git -C .cache/tavern-helper checkout ecd74c73518f6607387bed95a966fc1e2b8057c7
```

在已启动本应用的专用、可丢弃 Android 模拟器上运行：

```sh
TAVERN_UI_TEST_DISPOSABLE=1 \
TAVERN_BENCH_ADB_SERIAL=emulator-5554 \
node scripts/smoke_tavern_helper.mjs
```

驱动需要 Node.js 22+、ADB、该模拟器已有的 `su` 能力，以及属于本应用主进程的 WebView 开发者 socket。正式包通常关闭 WebView 调试；本次签名包测试环境另有 root／开发者可观测条件，不代表普通手机会开放调试接口。它只读取本应用的备份节流配置以安排清理，不更改系统设置；若已安装酒馆助手或页面正在生成／保存／编辑，会拒绝继续。

可用 `TAVERN_HELPER_CHECKOUT` 指定固定插件检出的绝对路径，用 `TAVERN_BENCH_ADB_PATH` 指定 ADB，用 `TAVERN_HELPER_REPORT_PATH` 指定尚不存在的报告路径。默认检出目录为 `.cache/tavern-helper`，报告写入 `.cache/`。驱动先校验本地提交、插件版本和 dist 摘要；随后仍从官方 URL 安装，并核对手机实际安装的相同身份。若官方 main 已更新，测试会因版本／提交／摘要不符而失败并清理本次安装，不会把新版本当成已验证版本。

测试会临时切换角色、安装并移除插件、最后重载页面；仅在专用测试数据上运行。原设置和草稿保留在页面内存中，设置落盘请求被阻止，最终核对设置文件字节。完整插件源码及其许可仍由官方仓库提供。
