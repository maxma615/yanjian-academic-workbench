# 全文翻译实施计划

> 历史记录：此计划记录最初的翻译引擎与独立页面实现。用户随后明确翻译属于文献阅读，现行入口与界面以[文献阅读内的全文翻译](2026-10-23-reading-translation.md)为准；原有引擎、持久化、凭据与备份规则继续使用。

**Goal:** 在研笺的本地文献库内完成英文 PDF 提取、全文中文翻译、双语阅读、断点继续和备份恢复。
**Architecture:** 沿用 React / Express / Electron。PDF 在本地提取，用户主动开始后仅将文字分段发到指定的 OpenAI 兼容 API。任务结果独立保存，不修改 PDF 或文献元数据，不加入 GitHub 同步。
**Spec:** 用户 2026-10-23 最新需求及根 docs/specs/academic-workbench.md；本页记录本轮新增设计。

## 设计选择

采用可提取文字 PDF 的逐页双语阅读，原 PDF 仍能打开；所有提取段落都参与翻译，空白/扫描页明确标记。与直接嵌入 BabelDOC 的原位排版方案相比，这条路径不增加 Python/OCR 环境和 AGPL 组件，适合当前 MIT Electron 应用。与一次性通用模型调用相比，采用有界分块、规则版本、术语表、完整性校验与逐块保存。暂不承诺扫描 OCR、复杂表格/公式的原位重排或学术准确率。

界面延续米白/薄荷绿，增加「文献翻译」导航。左侧任务列表，主体为准备状态或按页、段对齐的原文/译文；设置包括 API 地址、模型、密钥、术语表与额外要求。无密钥时仍可提取和阅读原文。提供测试连接、开始/暂停/继续、导出双语 Markdown；仅在用户主动开始后发送论文文字，并显示目的地址。版本化规则可在 UI 展开查看。

## Global Constraints

- 只修改 academic-workbench 及本任务拥有的根规格/计划，不修改根 PLAN、情侣小屋或真实资料。
- 翻译和原文存 papers/<paperId>/translations/<jobId>.json；JSON 带 schemaVersion，正文是权威资料，纳入完整备份，禁止 GitHub 同步。
- 状态 ready/running/paused/failed/completed；重启后的 running 按 paused 展示，绝不自动联网。暂停保留完成段，继续跳过已有译文。单个后台任务执行，不阻塞 CRUD 和进度读取。
- 每次落盘进入 Workspace.exclusive 并检查写锁。删除、恢复切换、关闭与后台任务协调；只读实例只能阅读/导出。
- 系统加密存储单独保存翻译密钥；开发浏览器仅内存保存密钥；配置和备份中不得包含密钥。更换 endpoint 不能沿用旧 endpoint 的密钥。
- HTTPS API 或明确的 localhost HTTP；禁止 URL userinfo/query/fragment；禁重定向带出密钥。报错不得回显上游内容或密钥。
- 保留原文的公式、引用、数字和限定语；学术规则不是准确率保证。扫描/提取失败/漏段/截断不能当作全文成功。
- Windows11 为目标，Mac 验证不算 Windows 验收。无需真实密钥即可跑离线+模拟服务自动测试。

## Review Focus

恢复期间旧 API 响应落入新资料目录；中断与取消导致已译段丢失；备份丢译文或携带密钥；PDF 双栏/扫描导致漏读却宣称完成；上游返回缺段/截断/英文原样而 UI 宣称成功。

## Task 1: 翻译协议与引擎

Files: src/shared/translation.ts, server/translation-engine.ts, tests/integration/translation-engine.test.ts, package*.json, scripts/build-desktop.mjs。
- [x] 先测试真实 PDF 提取、空页/无文字、双栏顺序、稳定分段。
- [x] PDF.js 本地提取；实现 extractPdf(bytes) => {pageCount, blocks, warnings}。
- [x] translateBlocks(config,key,blocks,context,signal) 返回逐段译文与检查提醒；使用有界 JSON 输出，严格核对段 ID 和 finish_reason。
- [x] 测试 URL、无重定向、网络超时/中断、缺段/截断、术语规则、敏感错误隐藏。
- [x] 确认 Node 和生产 Electron bundle 的 PDF 依赖可用。

## Task 2: 本地运行时与 API

Files: server/translation-runtime.ts, server/app.ts, server/workspace.ts, src/backup/backup-service.ts, electron/credentials.ts, electron/main.ts。
- [x] 先测试创建任务后无外发、开始显式授权、逐块保存/失败恢复/重启暂停。
- [x] 设置 API 和凭据作用域，后台运行只在落盘时占队列；添加认证的 /api/translation/settings 与 /api/translations 路由。
- [x] 严格校验任务 JSON，完善只读、删除、恢复和 close 协调。
- [x] 备份/恢复包含任务，恢复前校验来源 PDF 哈希与任务身份。测试二实例写锁、资料切换、同步排除和旧工作区兼容。

## Task 3: 翻译管理与双语阅读

Files: src/client/TranslationPanel.tsx, src/client/translation.css, src/client/App.tsx, src/client/api.ts, tests/e2e/translation.spec.ts。
- [x] 管理任务和选择已导入 PDF；已完成内容离线可读，分页对照，进度/错误/质量提醒可见。
- [x] 接口配置、术语表、测试连接、规则说明、明确的外发目的提示；密钥不写入浏览器存储。
- [x] Web E2E 使用真实 PDF 与本地假 API 跑完整翻译/暂停/继续/导出。
- [x] 截图检查桌面布局与窄窗口布局，修复溢出、可访问标签和空状态。

## Task 4: 集成验收

- [x] 全套 npm test、typecheck、build、Web E2E、Electron smoke；独立审查任务运行与隐私边界。
- [x] 更新使用说明和实际测试证据，重启本应用本地预览并打开翻译界面。
- [x] 未配置真实模型，不宣称实际 DeepSeek 翻译质量已验收；旧发行包不代表本次功能已打包。

## 进度记录

2026-10-23：应用 Git 初始干净，原基线 113 项测试通过。用户已明确理解后动手；本轮常规技术选型直接执行，不追加设计审批。按文件所有权并行实现，最后统一审查。

实现记录：按任务冻结模型和术语配置，开始前比对用户确认的配置，避免另一窗口修改目的地后继续沿用旧确认；纯英文叙述原样返回时拒绝标记成功。备份升级保留其他权威文件的原始字节，覆盖已有同步冲突记录。后台翻译与删除、恢复、写锁协调，旧响应不会落入恢复后的资料目录。

收尾修正：无凭据时读取本地翻译/同步设置不探测操作系统钥匙串；已存密钥不可读时仍返回配置及通用恢复提示，允许清除，开始和连接测试保持拒绝外发。实际保存凭据仍要求系统加密可用。

最终验证：23 文件 / 197 项单元与集成测试、11 项浏览器 E2E、4 项 Electron smoke 通过，TypeScript / Vite 构建通过，依赖审计 0 漏洞。预览 `http://127.0.0.1:5178/#translations` 经实际浏览器验证并请求在 Codex 打开（工具返回 queued）。完整证据和未验收边界见 [使用说明](../paper-translation.md)；没有创建新版发行安装包、提交或推送。
