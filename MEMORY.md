# MEMORY.md

## 项目概况

- 项目名称：Video Knowledge Capture / 视频知识捕手
- 项目 ID：`P0004`
- 创建日期：2026-07-19
- 项目目标：通过 Agent Skill 或本地入口，把用户有权处理的公开视频下载、离线转写并写入显式配置的 Obsidian Inbox。

## 稳定约定

- `PROJECT.yaml` 是项目身份、当前里程碑和验收边界的唯一结构化来源。
- 公开仓库只记录稳定架构决策和可复现命令，不记录用户目录、真实知识库路径、PID、真实分享标识、临时验收目录或个人授权记录。
- 凭据只记录用途和安全边界，不记录值；`.env`、Cookie、Token、解密键、浏览器资料和证书私钥不得进入仓库。
- 自动验收默认使用系统临时配置、Inbox 和媒体目录；技术验证不能替代用户对内容质量和日用价值的人工验收。

## 架构决策

- 核心使用 Node.js 20+ ESM 和内置模块。P0004 本地服务是下载、离线 ASR、去重、失败台账、媒体保留和 Obsidian 写入的唯一所有者。
- 服务只监听 `127.0.0.1`。Web、CLI、Hermes 和其他 Agent 入口复用相同的 `/api/intakes` 与持久任务合同，不形成第二套下载或写库逻辑。
- 去重键基于清除片段和常见跟踪参数后的规范 URL SHA-256；目标笔记使用确定性文件名和排他创建，失败写入追加式台账并支持幂等重试。
- Inbox 必须由用户显式指定，不提供真实知识库默认值。普通页面提取逐跳阻断本机、私网、链路本地、保留地址和非标准端口。
- 媒体任务按下载、音频提取、转写、写入和清理分阶段持久化。成功清理临时媒体和派生文件；失败保留在受管隔离目录直到重试或显式清理。
- 第三方运行时安装在用户应用数据目录，不提交到仓库。版本、来源和摘要固定，执行前复算所需文件完整性。
- 公开视频下载器禁用用户配置、播放列表、直播和浏览器 Cookie 导入；平台登录、私有、付费、地区限制或 DRM 内容明确失败，不绕过访问控制。
- 抖音只使用任务级匿名隔离浏览器资料和一次性 Cookie 文件；任务结束后无论成功失败都清理。小红书必须保留当前完整分享链接中的时效参数。
- 微信视频号优先使用腾讯元宝隔离登录路线；明文会话只在内存中使用，持久化记录使用 Windows DPAPI 当前用户保护。桌面微信 sidecar、证书和捕获只能显式启用。
- Windows 防火墙按可执行文件路径识别桌面微信 sidecar。受管补丁副本固定为 `<config>/work/wx-channel-buffer/runtime/wx_channel.exe`，每次任务只隔离 `runs/<run_id>` 下的配置和数据；不得再从随机可执行文件路径启动。
- 桌面微信 sidecar 使用两条路径限定的入站阻止规则覆盖原始运行时和受管副本，阻止所有网络配置文件的外部入站访问；不得通过关闭防火墙或放行公用网络来消除提示。
- Hermes 插件只注册 `video_knowledge_capture` 和 `video_knowledge_status`，通过固定 loopback JSON 调用 P0004；消息渠道授权由 Hermes 单独控制。
- 回执合同固定为 `completed`、`duplicate`、`processing`、`failed`、`unavailable`。只有前两者证明完成；本社区版本不提供电脑离线时的云端队列。

## Skill-first 公共发行决策

- 2026-08-24：`skills/video-knowledge-capture` 成为唯一 canonical Skill。Codex、Claude Code、Hermes 和自定义 Agent Skills 目录由精确同步安装器复制该目录。
- canonical Skill 包含简洁的 `SKILL.md`、OpenAI UI 元数据、宿主安装参考和固定 loopback Node 客户端。Hermes 仅额外提供结构化工具插件。
- 安装器只能清理自己管理的 `video-knowledge-capture` 目录，拒绝符号链接和文件系统根目录，不修改其他 Skill 或插件。
- 社区发行采用 PolyForm Noncommercial 1.0.0，准确标记为 `source-available`。商业使用需要单独书面许可；外部贡献必须同意 `CLA.md`，以允许未来社区版和商业版共同演进。
- 许可证、商业授权、CLA、贡献规则、第三方声明和品牌规则分别保存在根目录，不用 README 一句话替代法律文件。
- 2026-08-25：维护者确认根目录 `SECURITY.md`。策略覆盖 canonical Skill、本地服务、平台适配、运行时和 Obsidian 写入，并固定 loopback、SSRF、路径、凭据、完整性及私密披露边界。
- 2026-08-25：维护者授权创建公共 GitHub 仓库 `https://github.com/leonwang2mini-beep/video-knowledge-capture` 并推送 `main`；仓库保持 source-available 定位，不因公开可见而变成 OSI 开源。
- 2026-08-26：M10 将 OpenClaw 纳入显式 Skill 安装目标，并新增 `setup:community`、`doctor` 与 `verify:community`。Skill 不能脱离 Windows 本地引擎单独完成下载、转写或写库；QQ、微信等聊天软件只有在其 Agent 已具备 Skill 发现、本机工具权限和渠道授权后才可能接入。
- 社区安装要求显式指定一个宿主和一个已存在、可写的 Inbox；`all` 只用于用户明确要在同机安装全部宿主的场景。安装器拒绝磁盘根配置目录和路径链中的符号链接 / junction，只清理 `video-knowledge-capture` 受管目录。
- `doctor` 是只读 JSON 诊断：检查 Windows、Node.js、Inbox、核心运行时、宿主文件和固定 loopback 服务，并拒绝与仓库版本不一致的旧服务；它不替代具体平台、手机消息或真实用户 E4。

## 宣传定位

- 2026-08-25：首条公共推广视频采用“双端真实演示”。电脑端展示 Codex/Web 调用 canonical Skill，移动端重点展示用户在飞书把公开视频链接发给 Hermes，家庭电脑上的 P0004 随后下载、离线转写并写入知识库。
- 移动端便利性是首发宣传的主要差异点，但对外必须同时说明电脑、Hermes Gateway 和 P0004 需要保持在线；正式录制前还要完成一次由真实手机发起的 E4 验收，不能用临时技术验收冒充真实手机闭环。
- 2026-08-26：公共推广内容统一使用 GitHub 仓库名 `video-knowledge-capture`，不显示内部项目 ID。兼容性采用两层表述：Codex、Claude Code、Hermes 和自定义 Skill 目录属于已验证入口；QQ、微信等消息渠道及其他 Agent 只能表述为通过兼容 Agent Skills 或适配器调用本地接口后可接入，不能说成全部开箱即用。推广成片必须包含清晰中文旁白和可听背景音乐。

## 已验证命令

- `npm.cmd test`：1.4.0-beta.1 通过 101 项离线测试，覆盖核心、HTTP、运行时、平台适配、四宿主 Agent Skill 安装、Hermes、doctor、配置根目录、路径 junction、凭据保护和微信 sidecar 防火墙目标。
- `npm.cmd run verify:runtime`：固定版本的 yt-dlp、FFmpeg、whisper.cpp、模型和 wx_channel 可复算安装后摘要。
- `npm.cmd run verify:usable`：使用临时配置和 Inbox 验证本地 HTTP 创建、去重、失败和重试，不访问真实知识库。
- `npm.cmd run verify:hermes`：使用临时 Hermes Home、临时配置和 Inbox 验证插件发现、提交、状态查询、完成、重复和失败映射。
- `python quick_validate.py skills/video-knowledge-capture`：canonical Skill 的名称、frontmatter 和结构验证通过；Windows 运行时设置 `PYTHONUTF8=1`。
- `node --test test/agent-skill.test.mjs test/hermes-integration.test.mjs`：Codex、Claude Code、自定义 Skill 目录、bundled client 与 Hermes exact-sync 均有隔离测试。
- `npm.cmd run verify:community`：使用临时用户目录、配置和 Inbox 安装 Codex、Claude Code、Hermes 与 OpenClaw 集成，并在注入的健康运行时和 loopback 服务下让 doctor 达到 `ready`；该结果是 E3 模拟，不是实际宿主 E4。
- `npm.cmd run verify:public-release`：1.4.0-beta.1 的干净本地克隆通过 101 项离线测试、临时首用、四宿主隔离首装和 98 文件公共发行审计；审计阻断个人路径、真实分享标识、PID、凭据材料、Python 缓存和重复 Skill 源。
- `py -3 resolve_security_md.py --repo . --scope . --out -`：根目录 `SECURITY.md` 是唯一有效策略，解析链无冲突。
- `git clone --local --no-hardlinks . <temporary-directory>`：独立 `main` 检出在验证前后均保持干净，101 项测试、98 文件审计、临时首用、四宿主隔离首装和 canonical Skill 校验通过。
- `gh run view 32861621767 --repo leonwang2mini-beep/video-knowledge-capture`：首次公开 push 的 Windows CI 在 Node.js 20 和 24 上均通过离线测试与公开发行审计。
- `PYTHONDONTWRITEBYTECODE=1`：所有 Python 集成验证子进程禁用字节码缓存，避免测试污染待发布工作树。
- `npm.cmd run wechat:configure-firewall`：在管理员 PowerShell 中一次性清理 P0004 旧随机路径规则，并安装固定的本机专用入站阻止规则。
- `npm.cmd run wechat:firewall-status`：只读确认两条固定规则均为 `Inbound`、`Block`、`Any`；`npm.cmd run wechat:uninstall-firewall` 可精确撤销。
- `hermes gateway status --deep`：本机升级到 1.3.3 后六项 Gateway 探针通过；`GET /api/health` 同时确认 P0004 仅监听 `127.0.0.1`。

## 踩坑与限制

- Windows PowerShell 执行策略可能拦截 `npm.ps1`；项目命令使用 `npm.cmd`。
- 仅把 patched sidecar 改成稳定路径还不够；历史随机路径已产生的 Windows 防火墙规则必须限定为 P0004 受管路径后批量清理，否则会持续累积并让问题难以定位。
- `audit:public-release` 会遍历整个工作目录而不是只审计 Git 发布树；被 `.gitignore` 排除的本地 `out/` 也可能触发误报，发行证据应在只包含 `git ls-files --cached --others --exclude-standard` 的临时镜像中复验，且不得删除用户生成物。
- Node.js 24 在 Windows 上删除空目录时可能对 `fs.rm(path)` 返回 `ERR_FS_EISDIR`；已知空目录使用 `rmdir()`，递归删除只针对测试创建的限定临时根目录。
- 浏览器或平台规则变化可能让先前可用的公开链接失败；错误必须保留稳定分类，不能伪造字幕、改用用户 Cookie 或旁路 P0004 写库。
- Skill 是交互和适配层，不包含云端处理能力。本地 P0004 服务、Node.js 和所需运行时仍必须安装并运行。
- 项目当前只支持 Windows 本地运行；Codex 和 Claude Code 的 Skill 目录安装不等于跨平台运行时支持。
- OpenClaw 当前只完成官方用户 Skill 目录的隔离安装、bundled client 合同和 doctor 模拟；真实 OpenClaw 进程发现、工具授权和端到端捕获仍待 E4。
- PolyForm Noncommercial 不是 OSI 开源许可证。对外描述必须使用 source-available 或非商业社区源码。

## 外部资源

- PolyForm Noncommercial 1.0.0：`https://polyformproject.org/licenses/noncommercial/1.0.0`
- Agent Skills：`https://agentskills.io`
- Claude Code Skills：`https://code.claude.com/docs/en/slash-commands`
- whisper.cpp：`https://github.com/ggml-org/whisper.cpp`
- yt-dlp：`https://github.com/yt-dlp/yt-dlp`
- wx_channel：`https://github.com/nobiyou/wx_channel`

## 后续事项

- 公共仓库已建立并跟踪 `origin/main`；后续推送仍应先保持工作树干净并运行与风险相称的发行审计。
- GitHub Private Vulnerability Reporting 尚未启用或验证；这是独立的远端安全设置，不能从 `SECURITY.md` 文件存在与否推断。
- 公开发布前由熟悉软件许可的律师复核 `LICENSE`、`CLA.md` 和商业许可边界。
