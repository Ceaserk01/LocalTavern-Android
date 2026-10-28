# 本地酒馆 Android 0.1.0-alpha.1

首个公开 Alpha：在 Android 手机内同时运行 SillyTavern 1.19.0 与 Node.js 24.22.1。安装后打开 App，配置模型 API 即可使用；无需 Termux 或自行部署后端。

- 保留上游完整界面与后端，支持角色卡、世界书、聊天、预设、流式生成和原有模型接口。
- 支持 Git URL 安装 / 更新 / 切换前端扩展，以及 ZIP 导入前端扩展和服务端插件。
- 原生文件选择、分块文件导出、数据备份恢复、前台服务、日志与重启。
- 前端预编译、Node 编译缓存、角色磁盘缓存、升级清理旧资源；保留真实 tokenizer 和 WASM 组件。
- AGPL-3.0 开源；附完整对应源码、固定依赖来源、签名证明与 SHA-256 校验和。

## 下载

- `LocalTavern-0.1.0-alpha.1-arm64.apk`：Android 8.0+ ARM64 手机。
- `LocalTavern-0.1.0-alpha.1-x86_64.apk`：对应架构的设备或模拟器。
- `LocalTavern-0.1.0-alpha.1-source.tar.gz`：安卓版源码及固定上游快照。
- `SHA256SUMS.txt`、`LocalTavern-0.1.0-alpha.1-manifest.json`：校验和、源码提交、运行时与资源来源。

Release 使用独立签名。若此前安装过开发调试包，请先在 App 中导出备份，再卸载开发包、安装此版本并恢复。相同正式签名的后续版本可以覆盖升级。

## 验证与范围

已在 Android 35 ARM64 模拟器验证核心后端、真实 tokenizer、角色图像导入导出、Git 扩展管理、ZIP 扩展、文件导出与备份恢复；详见仓库 `VALIDATION.md`。模型 API 测试使用本地模拟服务，不消耗付费账号。实体手机兼容性与大型资料库性能需要继续验证。

依赖桌面程序、未提供 Android 构建的原生模块、独立 Node 子进程或额外外部服务的插件需要相应适配。额外纯 JS 依赖可随插件 ZIP 的 `node_modules` 提供。备份和恢复统一限额为解压后 2 GiB、单文件 512 MiB、200,000 项。Node 移动运行时来自第三方预发布构建，不是 Node.js 官方 Android 发行版。
