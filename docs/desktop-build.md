# Electron 桌面构建

桌面壳沿用现有 React/Vite 与 Node 领域代码。构建时将 `electron/main.ts` 和 `electron/preload.ts` 分别打包为 `desktop-dist/main.cjs`、`desktop-dist/preload.cjs`；业务代码和 Express 依赖进入 bundle，Electron 与 Node 内置模块保持 external。安装包只带生产 `dist/`、桌面 bundle 和必要的 `package.json`，不会把开发资料、测试资料、缓存、依赖目录、凭据或测试归档带进去。

在 `academic-workbench/` 执行：

```sh
npm run desktop:build
npm run package:windows
npm run package:mac
```

`desktop:build` 先要求现有 Web 生产构建存在，再生成桌面 bundle。`package:windows` 默认生成 Windows 11 x64 的 NSIS 安装程序和 ZIP；也可以直接传 electron-builder 参数，例如：

```sh
node scripts/package-desktop.mjs --skip-build --win zip --x64
npm run package:mac
```

重打包后可用校验脚本核对当前磁盘上的 `dist/`、`desktop-dist/` 与 ASAR 内文件，并记录 ZIP 的 SHA-256：

```sh
node scripts/verify-desktop-package.mjs --zip release/<windows-x64.zip>
```

脚本将报告写入 `release/package-verification.json`；只要源文件与 ASAR 不一致、出现未授权文件或缺少构建文件就以失败退出。应在源代码冻结并完成最终重打包后运行，报告中的 ZIP 哈希才可用于交付记录。

缓存统一放在 `.cache/electron-builder/`、`.cache/electron/` 和 `.cache/tmp/`，产物放在 `release/`。脚本始终传 `--publish never`，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`；本轮不签名、不发布，也不读取账号凭据。Windows 安装器采用每用户安装、`asInvoker`、不删除应用资料的设置。应用资料仍由 Electron 主进程按系统应用数据目录管理，卸载后保留。

当前明确的产物范围是 Windows x64；用户目标机 CPU 架构尚未确认，因此不能把 arm64 或 x86 兼容性写成已验收。当前宿主为 macOS arm64，可构建 macOS arm64 `dir`/`zip` 用于 bundle 和目录清单检查；这不能替代 Windows 11 的安装、中文输入、系统 PDF 打开、junction/reparse point、权限变化和卸载保留实机验收。若 macOS 交叉生成 NSIS 因 Wine 或工具链失败，保留失败日志并继续使用可复现的 Windows x64 ZIP/Windows 机器构建流程，不把失败包装为成功。

配置依据：[electron-builder Windows targets](https://www.electron.build/docs/win/)、[NSIS options](https://www.electron.build/v26/docs/nsis/)、[CLI publish option](https://www.electron.build/docs/cli/) 和 [cache troubleshooting](https://www.electron.build/docs/troubleshooting/)。

## 本机交叉构建记录

2026-09-23 在 macOS 27 arm64、Node 26.9.0、Electron 44.4.3、electron-builder 26.15.3 上完成了：

- `npm test -- --run tests/unit/desktop-package.test.ts`：3/3 PASS。
- `node scripts/build-desktop.mjs`：主进程 1.3 MB、preload 1.0 KB bundle 成功；主 bundle 的 CommonJS `import.meta.url` 已转换为相邻文件路径，preload 未注入 Node 模块。
- `node scripts/package-desktop.mjs --skip-build --mac --arm64 --dir`：macOS arm64 目录包成功。
- `node scripts/package-desktop.mjs --skip-build --win zip --x64`：最终源冻结后重新生成 Windows x64 ZIP，大小为 153,934,749 bytes，SHA-256 为 `4f1c8a2ecc330964c1eeeec0e3595de1332c1dd00cab0b460d079a07efdbce03`。`release/package-verification.json` 报告 `ok: true`；Windows `app.asar` 清单实际只有 `dist/`、`desktop-dist/`、`package.json`，未发现 `node_modules/`、开发/测试资料或缓存。
- `node scripts/package-desktop.mjs --skip-build --mac --arm64 --dir`：最终源冻结后重新生成 macOS arm64 目录包，应用二进制经 `file` 确认为 arm64；可用于当前宿主的目录和 bundle 验证。

同一台 macOS arm64 宿主尝试 `--win --x64` 时，ZIP 已成功生成，但 NSIS 在执行交叉平台 `makensis` 时因宿主架构返回 `spawn Unknown system error -86`，因此没有把残留的 `.nsis.7z` 当作安装器交付。Windows 11 x64 上的 NSIS 安装、启动、IME、系统 PDF 打开、卸载后资料保留仍为 `NOT_RUN`；需在 Windows 目标机重新运行 `npm run package:windows` 验证。
