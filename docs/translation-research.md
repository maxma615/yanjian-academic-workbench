# 论文全文翻译：官方资料与实现边界

首次核对日期：2026-10-23。此记录支持研笺的本地全文翻译实现；后续按用户反馈补充 Scholaread 阅读交互及阅读器整合。未使用真实 API 密钥或私人论文验证模型质量。

## 本轮方案

PDF 在本地由 PDF.js 提取，逐页保存原文段落。用户主动开始后，使用其配置的 OpenAI 兼容服务按块翻译，结果保存为关联当前论文和 PDF 附件的本地译本，并在论文阅读器中英中对照阅读。该方案提供“可提取文字的全文翻译”，不重写原 PDF，不提供版式一致的中文 PDF，不将缺少文字层的页面当作已经翻译。

选择 PDF.js 是因为当前 Electron/TypeScript 应用可以使用 Apache-2.0 许可的 JavaScript 解析器，并且不引入 Python、OCR 或原生 Canvas 作为后台文本提取的运行依赖。`pdfjs-dist` 固定为 6.4.299。生产桌面构建保留 PDF.js 的 ESM 主模块、worker、CMap、标准字体和 WASM 文件，放在 `desktop-dist/pdfjs/`，避免将动态 worker 错误打进 CommonJS 主进程。后台提取仍只调用 `getDocument` / `getTextContent`，不进行 Canvas 渲染。

新增前端 `PdfReader` 使用随包 PDF.js 的 `page.render` 在浏览器 Canvas 显示原 PDF，并叠加 `TextLayer` 提供文字选取；它不构建 PDF 注释链接或执行 PDF 脚本。Vite 将 worker、CMap、标准字体、WASM 与 ICC 资源复制到本地 `pdfjs-assets/`，开发预览也从本应用提供这些资源。这里使用浏览器 Canvas，不新增 Node 原生 Canvas 依赖。原版 PDF 支持翻页、缩放、适应宽度与旋转；文字层失败时保留页面图像并提示。后台提取与前端页面渲染是两条独立路径，前者历史验证不能代替后者的浏览器和桌面验证。

PDF.js 6.4 的 `DocumentInitParameters` 已移除旧 `isEvalSupported` 参数；实现没有通过类型断言伪装使用该旧参数。Node 文本路径使用现代 ESM 构建；上游在原生 Node 下可能提示推荐 legacy 构建，这不是 OCR 或渲染能力证明。真实 Electron 加载需单独验证。

## 可借鉴的交互

- PDFMathTranslate-next：文件选择、页码范围、单独设置翻译服务、进度与取消、预览、单语/双语输出、术语表。研笺采用文献关联任务、逐页原文/译文、可见进度、暂停继续和结果导出；不能据此宣称已经采用其保留版式引擎。[官方 WebUI](https://pdf2zh-next.com/getting-started/USAGE_webui.html)、[UI 源码](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/main/pdf2zh_next/gui.py)
- Zotero PDF Translate：选择文字翻译、侧栏原文与译文、可调整分隔栏、加入笔记。它依赖 Zotero，不是可直接嵌入 Electron 的通用全文重排库。[官方仓库及使用说明](https://github.com/windingwind/zotero-pdf-translate)

## Scholaread：翻译从属于文献阅读

用户指出翻译应是文献阅读的子功能后，本次查阅 Scholaread 官方公开帮助页，并在未登录浏览器中查看了“开启翻译”和“重排模式”帮助页内的界面截图。没有注册、上传论文或实际使用其登录后应用；以下交互依据是官方文档及公开截图，不是对其引擎质量的独立验收。

| 官方交互依据 | 研笺当前对应实现 |
| --- | --- |
| 打开文章后，在阅读页上方启用「全文翻译」；截图中的按钮展开含开关和目标语言的小面板。[网页版开启翻译](https://www.scholaread.cn/help/web-faq-3) | 移除主导航里的独立翻译页面。从文献库打开某篇论文，阅读工具栏中的「全文翻译」展开当前文献的翻译面板，包含进度、暂停/继续、接口设置和本地译本。打开面板只准备本地文字稿，调用模型仍需确认目的地址并主动开始。 |
| 翻译视图中的译文紧随对应原文段落；关闭翻译可以阅读纯原文。[客户端对照式翻译](https://www.scholaread.cn/help/pc-faq-6) | 文本阅读提供「原文 / 中英对照 / 仅译文」，中英对照采用单栏逐段上下排列。收起翻译工具面板保留当前阅读视图，不暂停后台翻译；切回「原文」即可隐藏译文。显示切换不会重新调用模型。 |
| 重排模式与原文模式分别切换；重排可以调字体和字号。公开截图将「全文翻译 / 重排模式 / 文字」放在正文上方同一工具栏。[重排模式说明](https://www.scholaread.cn/help/web-faq-4) | 阅读器提供「原版 PDF / 文本阅读」；默认显示原 PDF，以便直接阅读图表和公式。文本阅读可调字号，切换两种模式保留当前页码。文字提取和逐段显示不等同图文保真的重排。 |

论文是导航和内容上下文，翻译任务是它的本地阅读资料。当前译本按 `paperId + attachmentId` 筛选，同一 PDF 的旧译本可继续打开，新建译本不覆盖旧结果。旧 `#translations` 链接进入文献库；新阅读链接为 `#papers/<paperId>`。仅打开原 PDF 不读取模型密钥，也不发起模型请求。

本轮借鉴的是阅读与翻译的关系、逐段对照和就近操作。Scholaread 的云同步、会员配额、OCR、划词翻译、图表与引用弹层、自动目录以及图文保真重排不属于这次已实现的对应范围。原始 PDF 的 Canvas 显示也不表示研笺已能生成保留版式的中文 PDF。

## PDF 能力边界

| 能力 | 本轮实现 | 局限 |
| --- | --- | --- |
| 原 PDF 阅读 | 本地 PDF.js Canvas 与可选取文字层，翻页、缩放、适应宽度、旋转 | 不修改 PDF；没有原位译文、PDF 注释交互或 OCR；文字层失败不影响原始页面图像阅读 |
| 原生文字 PDF | 按页提取，按坐标合并行，基础双栏先左后右，按段拆分 | 复杂跨栏、旋转/竖排、特殊字形、跨页段落仍需对照原文 |
| 保留原位版式的中文 PDF | 未实现；原 PDF 保留不变 | 文本提取不等于公式识别、表格结构恢复或重新排版 |
| 扫描/图中文字 OCR | 未实现；无文字页记录明确警告，全无文字则拒绝创建 | 混合页中的图片文字不会被翻译，不能保证覆盖整页可见内容 |

PDF.js 的 `getTextContent` 返回页面文字对象，不能据此推断已恢复论文的完整逻辑结构；[官方 `PDFPageProxy` 文档](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)。BabelDOC 的流程另外包括布局、公式和样式识别、占位恢复、字体映射与排版；其公式识别本身也有限制。[公式识别文档](https://funstory-ai.github.io/BabelDOC/ImplementationDetails/StylesAndFormulas/StylesAndFormulas/)

BabelDOC 的 `ocr-workaround` 文档描述了黑字白底覆盖处理，不能当作任意扫描件的通用 OCR 保证。原 PDFMathTranslate 在 2026-09 更新中仍将 OCR 标为实验能力。[BabelDOC 选项与限制](https://funstory-ai.github.io/BabelDOC/)、[PDFMathTranslate 更新记录](https://github.com/PDFMathTranslate/PDFMathTranslate)

## 规则与质量检查

应用随包提供 `academic-en-zh-v1` 规则，任务记录该版本。规则要求完整翻译、保留否定与条件、不过度强化结论、遵循术语表、保留数字/单位/引用、把论文作为数据而不执行其中指令。段落以 JSON 发送，携带文献标题，每段最多 2500 字符，每批最多 6000 字符和 100 段。

引擎对可识别的 TeX 公式、反引号代码、数字引文、DOI 和 URL 做占位保护；要求所有段落 ID 恰好返回一次，拒绝缺段、重复、未知 ID、空译文、模型截断和占位符丢失/重复/新增。普通英文叙述段原样复制或完全没有中文会使本批失败，保留为未完成；即使只加“译文”前缀也不能通过。作者名、明显书目、纯变量和短标签不强制硬译，疑似漏译仍有警告。数字差异和未使用指定术语作为复核警告。无法从 PDF 正确识别的公式不在此保护保证内；引用作者姓名和自然语言含义仍依赖模型与人工核验。

规则思路参考成熟工具的占位、术语与标题上下文实践，但本轮未复制 AGPL 提示模板或代码。[BabelDOC 翻译器实现](https://github.com/funstory-ai/BabelDOC/blob/main/babeldoc/format/pdf/document_il/midend/il_translator.py)

提示规则或 Skill 不能保证专业翻译准确。结构校验通过不等于准确率验收；模型可能仍漏译句意、误解术语或改变论断。所有警告和原文对照应在阅读界面保留。原始 PDF、规则版本、模型配置、任务结果是可追溯依据。

## 模型 API 与数据边界

DeepSeek 官方提供 OpenAI 兼容地址 `https://api.deepseek.com`。本次官方文档模型名为 `deepseek-flash` / `deepseek-v4-pro`，故界面允许编辑模型，不能依赖过时的固定名称。[官方接入文档](https://api-docs.deepseek.com/)

当前 DeepSeek Files API 只列 JPEG、PNG、GIF、WebP，不能把存在 Files API 理解为支持直接上传 PDF。研笺当前仅发送本地提取的文字与相关翻译配置。[Files API 文档](https://api-docs.deepseek.com/guides/files_api/)

API 地址仅允许 HTTPS 或明确 loopback HTTP，拒绝 URL 内嵌凭据、query、fragment；HTTP 禁止重定向，单次请求默认 60 秒（包括读响应体），最大响应 1 MiB，错误不回显上游正文或密钥。连接测试只发送固定短句。没有配置真实模型时不声称真实 DeepSeek 翻译质量已验证。

## 未来保留版式引擎的集成依据

PDFMathTranslate、PDFMathTranslate-next、BabelDOC 与 Zotero PDF Translate 均采用 AGPL-3.0。PDF.js 采用 Apache-2.0。研笺现有代码采用 MIT；未来集成 AGPL 引擎需要明确发行方式、相应许可证及源代码交付，不能复制后统一标为 MIT，也不能声称独立子进程自动消除许可证要求。[next 许可证](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/main/LICENSE)、[BabelDOC](https://github.com/funstory-ai/BabelDOC)、[Zotero 插件许可证](https://github.com/windingwind/zotero-pdf-translate/blob/main/LICENSE)、[PDF.js 许可证](https://github.com/mozilla/pdf.js/blob/master/LICENSE)

本次读取的 next `main` 元数据为 2.8.2，约束 BabelDOC `>=0.5.20,<0.6.0` 和 PyMuPDF `<1.25.3`；BabelDOC `main` 元数据为 0.6.4，要求 PyMuPDF `>=1.26.7`。两者都列 Python `>=3.10,<3.14`。这只是所读源码状态，不能视为两者最新稳定版可混装；未来应固定经过验证的完整版本组合。[next 依赖](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/main/pyproject.toml)、[BabelDOC 依赖](https://github.com/funstory-ai/BabelDOC/blob/main/pyproject.toml)

官方推荐通过 next 的 `do_translate_async_stream` 接入阶段进度/完成/错误及取消；BabelDOC 原生 API 被标为内部接口。Windows 有 win64 含资源发行包，CPU 可运行，但这些上游能力不代表研笺 Windows 11 已验收。[推荐 API](https://pdf2zh-next.com/advanced/API/python.html)、[Windows 包](https://pdf2zh-next.com/getting-started/INSTALLATION_winexe.html)、[CPU/GPU FAQ](https://pdf2zh-next.com/FAQ.html)

## 本地验证记录（2026-10-23 翻译增量）

以下为阅读器整合前的历史验证结果；不将这些数量或结果用于宣称本次前端 PDF 渲染和阅读交互已经验收。本次测试结果由收尾记录另行报告。

- 翻译引擎先失败再实现，当时 45 项测试涵盖真实多页 PDF、基础双栏、扫描/空页、分段上限、配置校验、本地 HTTP、取消/超时（含读取响应体）、响应大小、引文/公式保护和英文未译拒绝。使用合成论文与本机假模型服务，没有外发真实论文。
- 直接 CommonJS 模块加随包 PDF.js 资源：Node 26.9.0、Electron 44.9.3 内 Node 24.22.0 均实际提取两页四段，桌面运行包不含原生 Canvas 渲染依赖，文本提取不调用其接口；运行有上游“Node 推荐 legacy”提示。
- `npm audit fix` 未使用 force；Electron 同主版本更新至 44.9.3，Vite 7.3.7、Vitest/@vitest/mocker 4.1.12、http-cache-semantics 4.3.0、source-map-js 1.2.2。审计为 0 个漏洞；PDF.js 固定 6.4.299。
- 桌面测试已从临时 esbuild 简化构建改为正式 `scripts/build-desktop.mjs` 及完整资源复制；新增真实 PDF 提取与离线重启用例。旧测试构建先实际复现 `import.meta` 缺失导致的提取失败，正式构建修复该问题。最终 `npm run test:desktop` 四项全部通过（39.7 秒），覆盖真实两页 PDF 提取、无 Key 配置持久化、重启离线读取和原生导入/导出/完整备份恢复。原生文件选择弹窗用测试适配器返回路径，生产 IPC、业务逻辑、文件读写与 PDF.js 均实际执行。
- 无凭据文件时读取翻译配置不会探测系统钥匙串；仅打开资料设置时，GitHub 同步状态也只检查桌面适配器是否存在。实际保存 API Key 或连接 GitHub 时仍要求系统加密可用，没有降级为明文保存。
- 尝试真实 macOS `safeStorage` 凭据写入时，隔离 Electron 主线程阻塞在 `SecItemCopyMatching → SecKeychainItemCopyContent → SecurityServer decrypt`。此项未通过，不能宣称真实 macOS 钥匙串重启读取已验收；没有降级生产加密或使用真实密钥。Windows 11 系统凭据存储、安装与 PDF 提取仍须目标机验收。
