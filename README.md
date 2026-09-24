# 研笺 · 学术工作台

研笺是面向博士生个人使用的本地科研工作台。文献、PDF、笔记、研究日志、科研待办、日历与完整备份组成离线工作流程；应用与“有归”情侣生活空间的账号、数据、运行和发布相互独立。

## 当前状态

截至 2026-09-24，本地开发版已实现七个入口：概览、待办、日历、文献、笔记、研究日志、资料与设置。React UI 通过受认证的 Node loopback 服务读写真实 Markdown/JSON/PDF 文件，并提供 SQLite 索引重建、导出、完整备份和空目录恢复。运行证据见[实现记录](docs/implementation-progress.md)。

目标 OS 为 Windows 11，封装方向为 Electron；具体 build、CPU 架构和安装权限尚未确认。Electron 桌面主进程、原生文件操作、凭据加密及可选 GitHub 文本同步已接入；Windows x64 ZIP 和 macOS arm64 开发验证包可构建。Windows 11 实机验收尚未执行，NSIS 在当前 arm64 Mac 上受构建工具架构限制。GitHub 同步默认关闭；开发验证使用模拟资料仓库。此公开仓库仅保存源代码，不包含科研资料；如用户主动启用同步，科研文本应进入另行创建的私人资料仓库。最新结果见[桌面与同步记录](docs/desktop-sync-progress.md)。

## 启动与验证

所有命令在 `academic-workbench/` 执行，Node.js 需 24 或更新版本；本轮使用 Node 26.9.0。

```sh
npm ci --cache .npm-cache
npm run dev
```

默认打开 `http://127.0.0.1:5178`。若端口占用，服务会选择后续端口并打印实际地址；不会停止其他应用。开发资料在 `.dev-data/workspace/`，请只放测试资料。停止后再次运行可继续使用这些资料。

```sh
npm test
npm run build
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npx playwright install chromium --only-shell
npm run test:e2e
npm run desktop:build
npm run test:desktop
npm run desktop:dev
```

端到端测试启动独立服务和资料目录，阻断非本机网络请求，并验证重启和备份恢复。测试数据、浏览器缓存、报告和构建输出均位于本应用目录。

桌面开发启动 `npm run desktop:dev` 使用 `.dev-data/electron/`，与浏览器开发资料分开。安装后的 Electron 使用系统 `userData` 下的 `YanJian/data/`（Windows 通常为 `%APPDATA%/YanJian/data/`），其中 workspace 保存资料、control 保存活动目录指针及加密凭据。恢复后继续使用所选目录。构建与目标机检查见[桌面构建说明](docs/desktop-build.md)。

浏览器构建后可用 `npm start` 运行静态制品。其默认资料位置为系统应用数据目录的 `YanJian/workspace/`：Windows 使用 `%LOCALAPPDATA%`，macOS 使用 `~/Library/Application Support`，Linux 使用 `$XDG_DATA_HOME` 或 `~/.local/share`。这是目录选择逻辑，不能代替 Windows 实机验证。`ACADEMIC_DATA_DIR`、`ACADEMIC_CONTROL_DIR`、`ACADEMIC_PORT` 可显式指定独立的开发环境；恢复后的活动目录保存在 control 目录中。

## 文档入口

- [平台与工作流决策](docs/decisions/0001-platform-workflow.md)：已知事实、默认值、候选平台及五类样例。
- [Windows 11 实机交接](docs/acceptance/windows-handoff.md)：候选包启动、NSIS 构建、数据保留、原生文件和可选同步检查。
- [平台与数据验收矩阵](docs/acceptance/platform-matrix.md)：待执行用例与证据要求；文档检查不等同于平台验收。

## 资料与默认使用方式

当前本地开发版的行为与平台边界：

- 生产启动默认使用系统应用数据目录，真实资料不放进代码目录。笔记/日志是带 JSON front matter 的 Markdown，文献/待办/日历是 JSON，PDF 是本地附件；SQLite 仅作可重建索引。每条记录保留 UUID、格式版本和修订号。
- 同一资料目录只允许一个可写实例。保存成功显示本地保存时间；索引失败只影响检索，不能把已经落盘的资料说成未保存。
- Electron 中 PDF 通过系统默认程序打开，导入/导出使用原生对话框；导出精确原文件字节，取消不写入。浏览器预览保留文件输入和下载方式。Windows 系统 PDF 程序的实际关联仍待目标机验证。
- 桌面备份选择保存位置，浏览器预览通过下载获取，覆盖 workspace 清单、笔记/日志 Markdown、文献/待办/日历 JSON、本机 PDF，以及所有实体类型的墓碑、删除快照和冲突清单/副本；不含凭据、缓存或派生索引。取得稳定快照并复读校验归档后，才显示完成。
- 桌面恢复由原生对话框选择归档与独立空目录；renderer 只持有一次性授权标识，归档字节保留在主进程。浏览器开发预览允许明确填写独立空目录路径。服务复验真实位置、身份、权限和空目录后生成一次性 token；解包写入受管理暂存区，文件校验和索引重建成功后才提交并切换。归档不能指定目标路径。所有 HTTP/native 操作共用业务串行队列；桌面模式关闭 HTTP 任意路径恢复入口。
- 时间默认按 `Asia/Shanghai` 显示，纯日期保持日历日期。目录、PDF 打开器及备份位置沿用这些默认值，不逐项要求额外批准。

## 可选同步边界

只有笔记、日志、文献元信息及同类墓碑/冲突文本可进入 GitHub。待办和日历连同各自墓碑、冲突副本均不上传；PDF、删除快照、运行数据库、索引、完整备份、凭据和本机设置也不上传。完整备份仍包含待办、日历及其内部恢复资料。

GitHub 默认关闭，连接失败或断开不影响本地编辑与备份。同一资料发生双边修改时保留双方内容；另一个设备没有 PDF 时显示“附件未在此设备”。连接真实仓库须在桌面设置中填写私人 owner/repo/branch 和访问令牌，确认资料范围，再主动点击同步。仓库必须为专用文本仓库，已存在分支；README、代码等范围外文件会使整批同步停止。程序不会创建仓库或自动删除这些文件。令牌通过 Electron safeStorage 加密放在 control 目录，不进入代码、同步或备份。

## 开发边界与后续验证

所有配置、依赖、测试夹具和构建产物均放在本目录。不创建根包管理配置，也不依赖情侣小屋服务。2A 的开发机验证与 2B 的 Windows 11 Electron 验收分开记录；实际命令为 `package:windows`、`package:mac`，不签名或发布；Windows ZIP 为候选构建制品，不能等同目标机验收。

目标机需要实际验证安装/启动、中文输入、文件权限、PDF 导入打开导出、断网重启、单写实例、删除中断、索引重建、迁移以及完整备份/空目录恢复。M2 已加入模拟传输、完整远端树审计、并发冲突、离线重试与断开测试；真实私人 GitHub 资料仓库演练仍未执行。测试记录须列出设备和真实结果，开发机结果不能替代 Windows 11 目标机验收。

## License

本项目源码以 MIT License 发布，详见 [LICENSE](LICENSE)。依赖项和其他第三方内容仍受其各自许可证约束。
