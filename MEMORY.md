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
- Hermes 插件只注册 `video_knowledge_capture` 和 `video_knowledge_status`，通过固定 loopback JSON 调用 P0004；消息渠道授权由 Hermes 单独控制。
- 回执合同固定为 `completed`、`duplicate`、`processing`、`failed`、`unavailable`。只有前两者证明完成；本社区版本不提供电脑离线时的云端队列。

## Skill-first 公共发行决策

- 2026-08-24：`skills/video-knowledge-capture` 成为唯一 canonical Skill。Codex、Claude Code、Hermes 和自定义 Agent Skills 目录由精确同步安装器复制该目录。
- canonical Skill 包含简洁的 `SKILL.md`、OpenAI UI 元数据、宿主安装参考和固定 loopback Node 客户端。Hermes 仅额外提供结构化工具插件。
- 安装器只能清理自己管理的 `video-knowledge-capture` 目录，拒绝符号链接和文件系统根目录，不修改其他 Skill 或插件。
- 社区发行采用 PolyForm Noncommercial 1.0.0，准确标记为 `source-available`。商业使用需要单独书面许可；外部贡献必须同意 `CLA.md`，以允许未来社区版和商业版共同演进。
- 许可证、商业授权、CLA、贡献规则、第三方声明和品牌规则分别保存在根目录，不用 README 一句话替代法律文件。
- 2026-08-25：维护者确认根目录 `SECURITY.md`。策略覆盖 canonical Skill、本地服务、平台适配、运行时和 Obsidian 写入，并固定 loopback、SSRF、路径、凭据、完整性及私密披露边界。

## 已验证命令

- `npm.cmd test`：1.3.2 公共发行基线通过 92 项离线测试，覆盖核心、HTTP、运行时、平台适配、Agent Skill 安装、Hermes 和凭据保护。
- `npm.cmd run verify:runtime`：固定版本的 yt-dlp、FFmpeg、whisper.cpp、模型和 wx_channel 可复算安装后摘要。
- `npm.cmd run verify:usable`：使用临时配置和 Inbox 验证本地 HTTP 创建、去重、失败和重试，不访问真实知识库。
- `npm.cmd run verify:hermes`：使用临时 Hermes Home、临时配置和 Inbox 验证插件发现、提交、状态查询、完成、重复和失败映射。
- `python quick_validate.py skills/video-knowledge-capture`：canonical Skill 的名称、frontmatter 和结构验证通过；Windows 运行时设置 `PYTHONUTF8=1`。
- `node --test test/agent-skill.test.mjs test/hermes-integration.test.mjs`：Codex、Claude Code、自定义 Skill 目录、bundled client 与 Hermes exact-sync 均有隔离测试。
- `npm.cmd run verify:public-release`：92 项离线测试和 89 文件公共发行审计连续通过；审计阻断个人路径、真实分享标识、PID、凭据材料、Python 缓存、重复 Skill 源和缺失的 `SECURITY.md`。
- `py -3 resolve_security_md.py --repo . --scope . --out -`：根目录 `SECURITY.md` 是唯一有效策略，解析链无冲突。
- `git clone --local --no-hardlinks . <temporary-directory>`：独立 `main` 检出在验证前后均保持干净，92 项测试、89 文件审计和 canonical Skill 校验通过。
- `PYTHONDONTWRITEBYTECODE=1`：所有 Python 集成验证子进程禁用字节码缓存，避免测试污染待发布工作树。

## 踩坑与限制

- Windows PowerShell 执行策略可能拦截 `npm.ps1`；项目命令使用 `npm.cmd`。
- Node.js 24 在 Windows 上删除空目录时可能对 `fs.rm(path)` 返回 `ERR_FS_EISDIR`；已知空目录使用 `rmdir()`，递归删除只针对测试创建的限定临时根目录。
- 浏览器或平台规则变化可能让先前可用的公开链接失败；错误必须保留稳定分类，不能伪造字幕、改用用户 Cookie 或旁路 P0004 写库。
- Skill 是交互和适配层，不包含云端处理能力。本地 P0004 服务、Node.js 和所需运行时仍必须安装并运行。
- 项目当前只支持 Windows 本地运行；Codex 和 Claude Code 的 Skill 目录安装不等于跨平台运行时支持。
- PolyForm Noncommercial 不是 OSI 开源许可证。对外描述必须使用 source-available 或非商业社区源码。

## 外部资源

- PolyForm Noncommercial 1.0.0：`https://polyformproject.org/licenses/noncommercial/1.0.0`
- Agent Skills：`https://agentskills.io`
- Claude Code Skills：`https://code.claude.com/docs/en/slash-commands`
- whisper.cpp：`https://github.com/ggml-org/whisper.cpp`
- yt-dlp：`https://github.com/yt-dlp/yt-dlp`
- wx_channel：`https://github.com/nobiyou/wx_channel`

## 后续事项

- 本地 Git `main` 已建立单一根提交并通过独立干净检出验证；未授权前不创建远端或推送。
- 首次推送后观察 Windows GitHub Actions 在 Node.js 20 和 24 上真实执行；本地 YAML 和测试不能替代远端 CI 证据。
- GitHub 仓库公开时启用 Private Vulnerability Reporting；当前本地仓库没有远端，不能验证该外部设置。
- 公开发布前由熟悉软件许可的律师复核 `LICENSE`、`CLA.md` 和商业许可边界。
