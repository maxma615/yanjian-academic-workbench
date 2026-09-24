# Electron 桌面与可选 GitHub 同步交付记录

更新：2026-09-23。版本 0.1.0。本轮继续完成已授权的 Task 2B 原生实现与 Task 7 模拟同步，不把此前 59 测试 / 5 E2E 的 Web 里程碑当作整个项目交付。

## 当前可用结果

- 七个本地入口及真实文件存储继续可用：概览、待办、日历、文献与 PDF、笔记、研究日志、资料与设置。
- Electron 复用认证 loopback 服务，监听随机本机端口。renderer 隔离、sandbox、CSP、导航/权限拒绝及 IPC sender 校验已接通；关闭窗口会关闭服务并释放工作区。
- 原生对话框负责 PDF、导出、备份归档和恢复目录选择。取消无写入；备份字节和恢复授权保留在主进程。桌面 HTTP 接口不能提交任意恢复路径。Windows 路径/系统 PDF 关联仍待目标机验证。
- 安装后的资料默认在 Electron 系统 userData 的 `YanJian/data/`，Windows 通常是 `%APPDATA%/YanJian/data/`；workspace 与 control 分开。凭据经系统安全能力加密，保存在 control，不进入主资料、备份或同步。开发启动使用 `.dev-data/electron/`，测试使用隔离目录。
- 可选 GitHub 设置、同步状态、冲突查看/处理和断开连接已实现，默认关闭。浏览器预览不接受连接凭据。真实账号、仓库创建与上传均未执行。
- 现有预览仍为 `http://127.0.0.1:5178`。后端已更新，原 `.dev-data/workspace` 保留；最终检查为空资料、可写、索引 ready、同步 disabled。

## 同步行为

连接需要专用私人仓库的 owner/repo/已存在分支，以及该仓库 Contents 读写令牌。用户在桌面确认范围后保存设置，再主动同步；本轮没有代用户连接目的地。已有 README、代码、PDF 或其他范围外文件会让整批同步停止，程序不会自动删除它们来适配。

同步只交换 notes/logs/papers 元信息与同类墓碑/冲突文本；task/event 及其派生记录、PDF、删除历史、state、索引、备份和凭据排除。完整远端树审计拒绝范围外文件、链接/子模块、未知身份、伪装路径、无效关联和哈希。每份文本最多 8 MiB，远端总量最多 64 MiB。

Workspace 写锁、串行队列、快照 fingerprint 和持久 journal 协调批量应用。prepared 中断回滚，完整 committed 保留；外部改动或其他写实例使恢复停止，避免覆盖。先应用本地合并结果，再以 expectedRevision 发布，远端失败保留本地与旧基线；只有发布成功才推进基线。请求有 15 秒超时，错误不回显令牌或远端响应正文。

双边修改保留本地正文与远端副本，解决后产生新修订。删除与编辑冲突保留旧 UUID 的墓碑；选择保留内容生成新 UUID。解决前的双方内容保存在 `deletion-snapshots/sync-conflicts/`，进入完整备份。断开后可以离线解决冲突，状态仍为 disabled；清除凭据失败可见且可重试。

## 本轮实际执行

宿主：macOS 27.0 arm64、Node 26.9.0、npm 12.0.2。以下由整合任务在定稿源码上实际运行：

| 命令或证据 | 结果 |
| --- | --- |
| `npm test` | PASS：19 文件、113 项单元/集成测试 |
| `npm run build` | PASS：TypeScript 与 Vite 生产构建 |
| `npm run typecheck`（纳入 electron 目录后） | PASS：主进程、preload、服务、UI 与测试全部纳入检查；两处纯类型声明修正不改变运行 bundle 字节 |
| `npm run test:e2e` | PASS：6 条，真实 UI/API/文件系统；其中 1 条使用隔离的模拟 GitHub 仓库 |
| `npm run test:desktop` | PASS：3 条真实 Electron UI，原生 dialog 响应注入，业务 IPC/文件服务实际执行 |
| `npm audit --audit-level=low --cache .npm-cache` | 0 vulnerabilities |
| `node scripts/verify-desktop-launch.mjs` | PASS：实际启动已打包 Mac arm64 应用、保存、退出、端口关闭、重启读取与 profile 隔离 |
| `node scripts/verify-desktop-package.mjs --asar 'release/mac-arm64/YanJian Academic Workbench.app/Contents/Resources/app.asar'` | PASS：直接解出 Windows ZIP 内 ASAR，与当前构建逐文件 SHA-256 对比；另核对 Mac ASAR |

实际打包运行时：Electron 44.4.3、Node 24.21.0、Chromium 152.0.7977.130。独立记录为 [packaged-launch.json](../release/packaged-launch.json)、[package-verification.json](../release/package-verification.json)。

关键新增证据：

- `sync-deletion-loop.test.ts`：两个真实独立工作区，删除/编辑的四方向解决，旧 ID 不复活、新 UUID、墓碑、历史与再次发布。
- `sync-backup-restore.test.ts`：中文、同日多日志、关联文献、PDF、任务删除历史、解决后的双方冲突原文，一起备份并在新目录恢复；每个权威文件字节一致，PDF 可读、索引 ready。
- `sync-startup-recovery.test.ts`：prepared 回滚、committed 保留、外部改动拒绝，以及第二只读实例不处理主实例 journal。
- `sync-research-loop.spec.ts`：设置、双边编辑冲突、断开后离线解决、重新连接发布、断网重试、历史进入完整备份。
- `electron-smoke.test.ts`：窗口加载/隔离，创建文献，取消/导入/导出 PDF 精确字节，备份、选择空目录恢复、重启及关闭服务。
- `credentials.test.ts`/`sync-runtime.test.ts`：密文落盘、安全后端不可用拒绝、连接失败不留启用配置、断开清除失败可重试、默认无远端调用。

## 交付制品

- [Windows x64 ZIP 候选包](../release/YanJian-Academic-Workbench-0.1.0-win-x64.zip)：153,934,749 bytes。
- SHA-256：`4f1c8a2ecc330964c1eeeec0e3595de1332c1dd00cab0b460d079a07efdbce03`。
- [Mac arm64 验证应用](<../release/mac-arm64/YanJian Academic Workbench.app>)：用于当前开发宿主验证，不代表使用者平台。
- ZIP 和两个 ASAR 均未包含开发资料、测试夹具、node_modules、缓存或凭据；ASAR 仅为生产 dist、desktop-dist、package.json。
- 不签名、不公证、不发布。Windows ZIP 可解压运行主 exe；不是已验收的 NSIS 安装器。

## 明确未完成的目标环境验收

- NSIS 在当前 Mac arm64 交叉构建实际失败：electron-builder 提供的 x86_64 `makensis` 返回 `Unknown system error -86`。没有安装 Rosetta、修改系统或把中间 `.nsis.7z` 当成安装器。
- Windows 11 实机安装/卸载重装资料保留、中文 IME、系统 PDF 程序、权限/junction/reparse point 和原生句柄竞态、最终硬件兼容性：`NOT_RUN`。x64 为构建候选，不推定目标电脑架构。
- 每用户安装、asInvoker 与卸载不删资料是已配置/静态检查的行为，仍需真实 Windows 安装器实测。
- 真实 GitHub 私人仓库和系统安全存储的 Windows DPAPI 行为：未连接/未验收；现有结果来自模拟远端、加密测试适配器及 Mac Electron 宿主。
- Node 路径身份复验不能给出恶意同用户进程高频替换目录时的原生句柄级保证，未作该承诺。

目标 Windows 构建说明见 [desktop-build.md](desktop-build.md)，逐步验收见 [Windows 交接](acceptance/windows-handoff.md)。测试 fixtures 均在应用子目录并自动清理；没有改动根包管理、Git 状态、情侣小屋数据或真实私人仓库。
