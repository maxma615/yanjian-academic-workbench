# 平台与数据验收矩阵

更新日期：2026-09-23。M0/本地闭环和 Electron 主机适配已实现；M2 通过模拟仓库验证，最新结果见桌面与同步记录。Windows 11 安装/实机验收仍为 `NOT_RUN`，不能把 macOS 开发机证据当作目标机结果。

## 平台事实与证据口径

| 项目 | 当前记录 |
| --- | --- |
| 使用者目标 OS / 版本 | Windows 11；具体 build 未确认 |
| CPU 架构 / 安装权限 | 未确认 |
| 开发机证据宿主 | macOS 27.0 arm64、Node 26.9.0、npm 12.0.2；通用功能和真实 Electron 宿主验证，不代表目标机 |
| 可用目标验证设备及差异 | Windows 11 目标机尚未实测；开发机差异已知 |
| 候选决策 | `packagingCandidate=electron`；`packagingChoice=electron-direction-selected`，Windows 验收 `NOT_RUN` |
| 小屋可用里程碑 | 不构成学术端 2A–6A 编码门禁 |
| 书面计划 | 已确认，无需重复批准 |
| 本轮实际验证 | 最新全量单元/集成、6 条浏览器 E2E、3 条真实 Electron E2E 与制品记录见 [桌面与同步记录](../desktop-sync-progress.md)；不代表 Windows 安装通过 |

状态约定：`NOT_RUN` 未执行；`PARTIAL` 仅有自动测试或开发机子范围证据，不能代表完整人工/目标机用例；`PASS` 实际执行并附完整证据通过；`FAIL` 实际失败并记录影响；`N/A` 必须写出与选定平台相关的不适用原因，不能代替缺少设备。每条用例执行时填写设备角色（目标机/替代机）、OS 精确版本、CPU、应用制品与版本、依赖运行时版本、步骤/命令、预期和实际结果、证据位置及未覆盖范围。当前开发环境不自动成为她的验收设备。

测试夹具使用生成的合规 UUID、中文标题和可公开使用的样例 PDF，全部位于应用子目录。权限/链接/并发测试在独立测试目录执行，不能操作真实私人资料；进入真实验收仍要用完整应用验证，不能用静态原型替代。

2A 开发适配器是明确限定的开发例外：只能接收已认证本机开发 UI 中用户明确填写的目录，并以实际规范化路径、目录身份、空目录和权限检查创建绑定会话；业务层不接收未授权的任意路径，`displayPath` 不授予权限，也不暴露无限制文件接口。该适配器用于 macOS 开发机验证，不能把 PF-04/PF-05 标为 Windows 原生对话框通过；2B 必须用 Windows 11 原生 Electron 对话框重新验收。

当前实际适配边界是 `server/app.ts` 的认证 HTTP API：`GET /api/session` 建立本机会话，`/api` 要求会话 cookie 与 `X-Workbench-Token`，Host 仅接受 `127.0.0.1`/`localhost`，跨站来源拒绝；`POST /api/restore/target` 将开发 UI 明确填写的目录路径规范化、检查实际身份/空目录/权限并生成 token，`POST /api/restore` 只接受该 token。已有测试覆盖这些开发机边界，但没有 `PlatformPort` interface，也没有原生句柄级授权；选择后目录被替换等竞态仍须在 Electron/Windows 实测，不能把 HTTP 适配器证据写成原生安全验收。

## 开发机自动测试子范围与实际文件映射

以下结果只描述确实执行的测试文件或构建命令；它们不能把对应 PF/LC/RS 整体用例标成 `PASS`。命令均从工作区根目录运行，`--prefix academic-workbench` 令 npm 在应用目录执行。

| 子范围 | 实际命令 | 实际文件 | 当前证据 |
| --- | --- | --- | --- |
| HTTP 会话、loopback、真实持久化、备份/恢复 API | `npm --prefix academic-workbench run test -- tests/integration/api.test.ts` | `tests/integration/api.test.ts` | `PASS`：7 tests；包含跨端口独立会话、恢复领域关联校验和桌面 HTTP 原始恢复入口拒绝 |
| 权威文件、单写锁、删除快照、索引重建、PDF 导入 | `npm --prefix academic-workbench run test -- tests/integration/workspace.test.ts` | `tests/integration/workspace.test.ts` | `PASS`：14 tests；包括锁被替换后的提交拒绝、真实 POSIX 权限阻断与只读恢复 |
| 迁移、备份清单/路径安全、恢复目标 | `npm --prefix academic-workbench run test -- tests/integration/migration.test.ts tests/integration/backup-roundtrip.test.ts tests/integration/backup-safety.test.ts tests/integration/restore-target.test.ts` | 对应四个 integration test 文件 | `PASS`：35 tests（迁移 8、备份往返 4、归档边界 17、目标恢复 6） |
| Asia/Shanghai 日期换算 | `npm --prefix academic-workbench run test -- tests/unit/client-dates.test.ts` | `tests/unit/client-dates.test.ts` | `PASS`：4 tests；完整 CRUD 另见 E2E |
| TypeScript 与 Vite 构建 | `npm --prefix academic-workbench run typecheck`；`npm --prefix academic-workbench run build` | `tsconfig.json`、`vite.config.ts`、`src/client/` | `PASS`：开发机构建子范围；不代表 Windows 制品 |
| 真实 UI/E2E | `npm --prefix academic-workbench run test:e2e` | `tests/e2e/local-research-loop.spec.ts`、`scripts/run-e2e.mjs` | `PASS`：原有 5 条本地流程另加模拟同步闭环；实际最终命令结果见最新记录 |

实际桌面命令为 `desktop:build`、`test:desktop`、`package:windows`、`package:mac`。Mac Electron 主进程与隔离 renderer 已真实运行；对话框响应在 UI 自动化中注入，但真实文件服务、IPC 和写入均运行。Windows 原生对话框、系统 PDF 程序和安装/卸载仍为 `NOT_RUN`。

## PF：Task 2 平台基础验证

| ID | 操作 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| PF-01 | 在 Windows 11 目标机安装并首次启动 Electron 制品；记录联网安装与离线运行的区别，另测断网安装 | 包与架构匹配；断网安装结果如实记录；具体 build、架构和安装权限必须写入证据，不能用 macOS 结果替代 | NOT_RUN |
| PF-02 | 中文输入法组合输入、复制粘贴、窗口缩放后继续编辑 | 中文不丢字、不重复；组合输入结束前不误提交，字体和可操作区域正常 | NOT_RUN |
| PF-03 | 在系统应用数据目录读写中文/空格路径，随后重启 | 可写路径与 UI 显示一致；资料保留；权限不足可解释，不默认提权或写回代码目录 | PARTIAL |
| PF-04 | 选择 PDF、取消选择、调用系统打开 PDF；移除可用文件关联后再尝试 | 取消不写文件；目标机实际用默认程序打开；无关联时保留附件并给出可操作错误 | PARTIAL |
| PF-05 | 2A 用受认证的开发 UI 明确填写中文/空格空恢复目录并取消；构造伪造、过期或其他会话的 RestoreTarget token；2B 再用 Windows 原生对话框复测 | 开发 UI 返回受限授权并实际校验路径/目录身份/空目录/权限；取消无输出；伪造/过期授权不能访问目录，displayPath 不产生权限；仅能读写本次暂存区。2A 例外不等于原生验收；领域验证及索引未就绪时 commit 必须拒绝 | PARTIAL |
| PF-06 | 选择备份/导出保存位置，测试取消和无写权限 | 可写目标可创建样例输出，取消不创建，失败不覆盖既有文件；这是平台端口验证，不算完整备份恢复通过 | PARTIAL |
| PF-07 | 断外网、保持 loopback 或桌面进程；关闭小屋服务、重启；卸载/重装应用 | 独立启动；重启及卸载后资料保留；记录实际外部请求，默认无遥测 | PARTIAL |
| PF-08 | 若采用本地服务：端口占用、服务停止/重启、本机和非本机访问尝试 | 仅监听 loopback，有请求访问控制；端口占用和停止可诊断；系统 PDF 打开行为与浏览器预览区分 | PARTIAL |

2A 采用本地 Node 服务时必须执行 PF-08；Electron 封装后继续验证其 loopback 生命周期。安装/签名/分发的实测结果仅对应记录的制品和设备，不推定其他 OS 或架构已获支持。

## LC：Task 3–6A 本地流程、持久化与备份

| ID | 操作 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| LC-01 | 导入中文标题文献与 PDF，系统打开，导出；注入复制失败 | 导出 PDF 哈希一致；失败不形成悬空引用；无本机 PDF 时不导出空文件 | PARTIAL |
| LC-02 | 一篇笔记关联两篇文献，编辑中文并导出 Markdown/文献 JSON；取消导出 | 重启后关联与正文完整，未知元数据保留；导出与主文件字节一致，取消无文件 | PARTIAL |
| LC-03 | 同日创建两篇日志，分别编辑、检索和导出 | UUID 不同，互不覆盖；两篇均可恢复 | PARTIAL |
| LC-04 | 待办完成/删除、纯日期截止、全天及带时区事件，改变测试设备时区 | 月视图与当天列表一致，纯日期不漂移；离线重启后数据完整 | PARTIAL |
| LC-05 | 第二实例尝试写同一资料目录；备份期间保存和删除 | 第二实例只读；写入队列不丢已输入内容，稳定快照中的元数据和附件对应；成功或失败后恢复队列 | PARTIAL |
| LC-06 | 原子写入及删除操作记录、移动、墓碑各步骤注入中断后重启 | 旧完整版本可读；临时文件不冒充主资料；删除先恢复或回滚，再开放编辑和同步，不留下缺少墓碑的静默删除 | PARTIAL |
| LC-07 | 删除/损坏 SQLite，重建索引后搜索“消融实验”；模拟索引更新失败 | 主 Markdown/JSON/PDF 不变，关联保留；保存状态仍为已保存，中文查询结果符合样例 | PARTIAL |
| LC-08 | 旧格式夹具迁移，迁移中断，较新未知格式打开 | 迁移前备份已复读校验；失败时原目录哈希不变；较新格式拒写或只读，不丢未知字段 | PARTIAL |
| LC-09 | 从稳定快照完整备份，复读归档，恢复到新目录并在 UI 打开文本和 PDF | 逐项核对 workspace、notes/logs、papers 元信息、tasks/*.json、events/*.json、本机 PDF 及所有实体类型的墓碑/删除快照/冲突清单和副本；排除凭据/索引/缓存；权威路径、字节数、哈希一致，检索可重建 | PARTIAL |

五个代表性用户样例详见[平台与工作流决策](../decisions/0001-platform-workflow.md)。索引重建、备份恢复和迁移须在实现后运行真实服务与 UI 验证，未来测试命令列在[开发计划](../../../docs/plans/academic-workbench.md)。

## RS：Task 5–6A 恢复目标与归档边界

每条失败用例都要核对现用工作区及用户既有文件的哈希，确认活动根未切换。校验阶段失败要求原空目标仍为空；提交阶段失败只清理本次创建且身份仍可验证的产物，清理受阻时报告残留位置，不写“目标完全未变”。

| ID | 输入或操作 | 预期 | 状态 |
| --- | --- | --- | --- |
| RS-01 | 取消目标选择；仅选择归档而未选择目标；伪造/重用过期授权 | 取消无输出；读取归档不授予目录写入权；无有效目标授权不得解包写入 | PARTIAL |
| RS-02 | 选择含中文/空格的独立空目录，恢复合法完整备份 | 规范化保留正确显示路径；完整验证、提交后才切换；重启可用，权威清单与哈希一致 | PARTIAL |
| RS-03 | 选择非空目录、现用资料目录及其父/子目录，包含路径别名 | 写入前拒绝，原文件不变；依据真实位置/身份判断，不能仅比较字符串前缀 | PARTIAL |
| RS-04 | 归档含绝对路径、盘符绝对/相对路径、UNC、点路径、穿越、反斜杠、NUL、重复路径或目标系统下的名称冲突 | 解包前拒绝；不能写出授权根；大小写/Unicode/名称规则按真实目标文件系统验证 | PARTIAL |
| RS-05 | 目标为符号链接/Windows junction；归档含符号/硬链接或 reparse point；选择后路径被换为链接 | 拒绝，不跟随链接写入；可信父路径规范化后仍不得落入现用资料目录及其父子范围 | PARTIAL |
| RS-06 | 选择后替换/移动目录、撤销权限、并发放入文件；提交过程中再次制造同名文件 | 身份/权限/空目录复验或防覆盖写入拒绝操作；不改变现用资料，不覆盖并发新增文件，不自动提权 | NOT_RUN |
| RS-07 | 哈希错误、缺附件、重复清单、不支持版本；归档自带绝对目标位置或会话 token | 校验阶段失败，所选空目录保持为空；归档内信息不能改变目标授权 | PARTIAL |
| RS-08 | 暂存、跨卷复制/提交、最终切换各阶段中断，随后重启；同时模拟清理权限失效 | 结果确定前保持旧工作区；恢复/回滚操作可重试；仅在所选目标与受管理暂存区写入，不借用其父/同级目录，不删除用户新增文件，残留可定位 | NOT_RUN |

目录大小写、Unicode 名称、Windows 保留设备名、非法字符、链接与文件替换行为不得只用字符串 mock 判通过；Windows 目标机须用真实文件系统实测，自动夹具与人工证据共同记录。当前没有 Windows 安装/原生对话框运行结果。

## SY：Task 7 按原实体过滤同步

GitHub 引擎/传输/UI 已实现并默认 `disabled`。以下用例已有模拟传输和真实工作区测试；真实私人仓库演练另需明确目的地与授权。上传审计和远端应用校验均覆盖相同范围；完整备份另用独立规则。

| ID | 资料与操作 | 预期 | 状态 |
| --- | --- | --- | --- |
| SY-01 | 合法 notes、logs、papers 元信息；三类匹配的墓碑和冲突 manifest/原文本 | 类型、UUID、路径、格式、哈希均匹配后可同步；墓碑不要求已删除的原文件仍在 | PARTIAL |
| SY-02 | 混入 tasks、events 主文件和 `tombstones/task/`、`tombstones/event/` | 本地合法非同步条目被排除，远端完整树不含这些文件；远端若出现则在写回/发布前拒绝整批 | PARTIAL |
| SY-03 | `conflicts/<id>/tasks/<id>.json`、events 冲突及其清单，与合法笔记冲突混合 | 按原实体排除待办/日历冲突及其清单，只同步合法笔记冲突；不能因目录是 conflicts 就放行 | PARTIAL |
| SY-04 | 文献 PDF、冲突目录中的 PDF、删除快照、workspace、state、SQLite、缓存、备份、凭据 | 均未上传；文献类型标签不能给附件取得资格；远端含任意禁止条目时拒绝整批 | PARTIAL |
| SY-05 | 墓碑或冲突声明 note，但原路径是 tasks；UUID 不匹配、原类型缺失/未知 | 拟同步资料校验失败，停止批次；本地权威文件、上次成功基线和远端不变 | PARTIAL |
| SY-06 | 冲突内再次嵌套 conflicts 或指向墓碑/删除快照；缺清单、坏哈希、非法相对路径 | 不递归放行包装内容；应用远端之前整体拒绝无效快照，不能部分写回 | PARTIAL |
| SY-07 | 对同一组含任务/事件墓碑、冲突文本及 PDF 的资料分别执行文本同步和完整备份恢复 | 同步排除项仍在完整备份中；恢复后的权威文件清单和哈希完整，证明未把同步白名单误用为备份规则 | PARTIAL |
| SY-08 | 模拟双边修改、删除/编辑、发布前远端变化、断连重试；无 PDF 设备接收文献 | 双方文本/墓碑保全并可解决，发布使用远端修订检查；无 PDF 显示未在此设备；断开后仍能本地编辑备份。审计完整远端树而非过滤后的视图 | PARTIAL |

范围规则见[规格 §6](../../../docs/specs/academic-workbench.md)，文件及命令映射见开发计划 Task 7。SY 的自动化范围由 `sync-scope`、`sync-reconcile`、`sync-engine`、`sync-workspace`、`sync-runtime`、`sync-deletion-loop`、`sync-backup-restore`、`sync-startup-recovery`、GitHub transport 测试和 `sync-research-loop` E2E 提供证据。模拟通过不等同于真实 GitHub 或 Windows 平台验收。

## 历史 M0 文档验证记录

2026-09-23 实际执行：

```sh
rg -n 'targetOs|architecture|installPermission|packagingCandidate|Asia/Shanghai' academic-workbench/docs/decisions/0001-platform-workflow.md
rg -n '启动|中文输入|选择 PDF|打开 PDF|数据目录|备份|重启|卸载' academic-workbench/docs/acceptance/platform-matrix.md
```

两条命令退出码均为 0，所需字段与清单词均存在；当时平台未知项保留原值。另用系统 Python 标准库只读检查五份 Markdown：11 个本地链接均可解析到文件，代码围栏闭合，33 个用例编号完整且无重复，状态全部 `NOT_RUN`。当时的应用目录边界检查确认仅有本轮三份 Markdown、无产品代码、脚手架、包清单、锁文件或依赖目录；该描述是历史快照，不能用于判断当前实现状态。

首次文件边界检查因目录中出现 `.DS_Store` 报告额外文件；确认属于 Finder 元数据后保留原文件，仅将其从产品文件检查中排除，复查退出码 0。这一调整没有创建、删除或改动产品文件。

这些检查只验证当时准备文档的完整性；没有执行平台 smoke、单元/集成/E2E、打包或真实备份恢复。后续仍必须逐项运行上表用例并填写实际证据。

另完成一次独立文档复核，反馈的两项歧义已修正：在规格、计划与 README 中枚举完整备份的待办/日历等主文件；在计划中明确 `beginRestore`、受限 `RestoreSession.files`、`commit` 和 `abort` 的契约及相应验收。修正后重新运行上述文档完整性检查，退出码 0。这里记录的是历史文档复核及修订，不能作为产品运行证据。

## 当前实现记录

最新实际命令、测试数量、Electron 运行时、Windows ZIP 哈希、ASAR 字节核验和未覆盖范围统一记录在[桌面与同步记录](../desktop-sync-progress.md)。旧 59 测试 / 5 E2E 仅是前一轮 2A 里程碑，保留于[历史本地实现记录](../implementation-progress.md)。

| 新增验证子范围 | 文件/命令 | 实测边界 |
| --- | --- | --- |
| 原生文件授权、PDF、备份 token、IPC | `tests/integration/desktop-platform.test.ts` | 5 tests，实际隔离文件系统；shell/dialog 注入 |
| 安全凭据 | `tests/integration/credentials.test.ts`、`sync-runtime.test.ts` | 密文持久化、无安全后端拒绝、连接失败清理、断开清除重试；Windows DPAPI 仍需目标机 |
| Electron 真实 UI | `npm run test:desktop` | 3 条，导入导出、备份恢复、重启、数据隔离与端口退出 |
| 打包后的应用 | `node scripts/verify-desktop-launch.mjs` | Mac arm64 包的真实启动与重启，结果写入 release/packaged-launch.json |
| 制品内容 | `node scripts/verify-desktop-package.mjs` | ZIP 内 ASAR 与当前生产 dist/desktop-dist 文件逐个 SHA-256 一致才可交付 |
| 同步完整恢复 | `sync-backup-restore.test.ts` | 中文、同日日志、PDF、删除历史和解决后的冲突历史，新目录恢复后逐文件字节一致 |
| 启动恢复 | `sync-startup-recovery.test.ts` | prepared 回滚、committed 保留、外部修改拒绝、只读实例不恢复 |

未签名、未发布、未连接真实 GitHub；Windows 11 安装、IME、junction/原生句柄竞态、卸载重装保留与最终硬件兼容性均未验收。NSIS 的当前 Mac 宿主工具架构失败见构建记录，不能写为成功。
