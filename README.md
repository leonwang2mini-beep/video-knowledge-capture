# Video Knowledge Capture · 视频知识捕手

> Source-Available · Free for Noncommercial Use · Commercial License Available

一个 Skill-first、Windows 本地运行的视频知识采集项目：把用户主动选择的公开视频下载到本机，使用 FFmpeg 与 whisper.cpp 离线转写，再以结构化 Markdown 写入指定的 Obsidian Inbox。

本项目不是 OSI 定义的开源软件。个人学习、研究、非商业实验、修改和分享适用 [PolyForm Noncommercial 1.0.0](LICENSE)；商业产品、收费服务、商业生产使用或商业再分发需要[单独书面授权](COMMERCIAL_LICENSE.md)。

## 为什么是 Skill-first

仓库的主要入口是 [Agent Skill](skills/video-knowledge-capture/SKILL.md)。Codex、Claude Code、Hermes 和其他兼容 Agent Skills 的宿主共享同一份任务边界、状态合同和安全规则。

Skill 负责理解用户意图和调用本机能力；Node.js 本地服务负责下载、离线转写、去重、重试、媒体保留和知识库写入。这样避免为每个 Agent 重做业务逻辑，也不需要先投入完整桌面客户端或云服务。

```text
Codex / Claude Code / Hermes / compatible agents
                         ↓
        canonical video-knowledge-capture Skill
                         ↓
          loopback-only P0004 local service
                         ↓
 download → FFmpeg → whisper.cpp → dedupe → Obsidian
```

## 当前能力

- 一条链接自动路由、下载、离线转写、生成时间线和完整字幕；
- Obsidian Inbox 唯一写入路径、规范 URL 去重、失败留痕和安全重试；
- 默认保留经过校验的视频，也可只保留 Markdown；
- YouTube、普通公开 Bilibili、抖音以及带当前分享令牌的小红书已经过临时真实链路验证；
- 微信视频号优先使用腾讯元宝隔离登录解析，桌面微信捕获作为显式启用的备用路线；
- 不读取现有浏览器 Cookie，不处理播放列表、直播、私有、会员、付费、地区限制或 DRM 内容。

平台规则会变化。项目只承诺可定位的成功、失败或降级状态，不承诺每条链接永久可下载。

## 安装要求

- Windows 10 或更新版本；
- Node.js 20 或更新版本；
- 一个已存在、可写的 Obsidian Inbox 目录；
- 首次完整运行时安装需要下载 FFmpeg、whisper.cpp、模型和 yt-dlp，模型体积约 466 MiB。

## 快速开始

从仓库根目录运行：

```powershell
npm.cmd run setup:content
npm.cmd run setup:downloader
start-video-capture.cmd
```

浏览器会打开 `http://127.0.0.1:43127`。在“设置与恢复”中保存 Inbox 路径，然后回到首页粘贴一条用户有权处理的公开链接。

### 安装到 Codex

```powershell
npm.cmd run setup:skill:codex
```

Skill 会安装到 `%CODEX_HOME%\skills`；未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex\skills`。

### 安装到 Claude Code

```powershell
npm.cmd run setup:skill:claude
```

Skill 会安装到 `%USERPROFILE%\.claude\skills`。Claude Code 遵循 Agent Skills 标准，可自动发现该 `SKILL.md`。

### 安装到 Hermes

```powershell
npm.cmd run setup:hermes
hermes plugins enable video-knowledge-capture --no-allow-tool-override
```

Hermes 使用同一份 Skill，并额外安装两个结构化工具：`video_knowledge_capture` 和 `video_knowledge_status`。消息渠道授权仍由用户在 Hermes 中单独控制。

### 安装到其他 Agent Skills 宿主

```powershell
node scripts/install-agent-skill.mjs --target custom --skills-dir "D:\AgentSkills"
```

安装器只精确同步 `video-knowledge-capture` 目录，拒绝符号链接目标，不修改其他 Skill。

## 日常使用

向支持的 Agent 发送一条完整公开链接，并说明“收录到我的视频知识库”。Agent 返回五种事实状态：

- `completed`：已经下载、转写并写入；
- `duplicate`：已存在，没有创建第二份笔记；
- `processing`：本机已接收，使用 `job_id` 稍后查询；
- `failed`：返回稳定错误码、可重试性和下一步；
- `unavailable`：电脑或本地服务不可连接，没有伪装成已排队。

电脑需要保持开机并运行本地服务。本社区预览版没有云端离线队列。

## 数据与安全边界

- 主服务固定监听 `127.0.0.1`，不开放公网端口；
- 配置、状态、第三方运行时和临时工作区位于 `%LOCALAPPDATA%\VideoKnowledgeCapture`；
- Inbox 和保留媒体目录由用户显式配置，不内置个人路径；
- 公开页面逐跳阻断本机、私网、链路本地和保留地址；
- 下载器固定版本、校验哈希、禁用用户配置、播放列表、直播和浏览器 Cookie 导入；
- 下载 URL、解密键、Cookie 和临时令牌不会写入 Markdown 或公开任务结果；
- 微信桌面捕获备用路线使用稳定的受管可执行文件路径，并可通过一次性防火墙配置阻止外部入站访问，避免每次任务重复出现 Windows 网络访问提示；
- 自动测试只使用系统临时目录，不访问真实知识库。

详细操作见 [使用指南](docs/USER_GUIDE.md)，架构和验收边界见 [项目简报](docs/BRIEF.md)。

## 验证

```powershell
npm.cmd test
npm.cmd run verify:runtime
npm.cmd run verify:usable
npm.cmd run verify:hermes
```

真实平台验证会访问用户提供的公开链接，只应在明确授权和临时 Inbox 下执行。技术验证不替代用户对转写质量和日用价值的人工验收。

## 社区与商业化

- 参与贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CLA.md](CLA.md)；
- 第三方运行时及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
- 项目名称与品牌使用边界见 [TRADEMARKS.md](TRADEMARKS.md)；
- 商业授权说明见 [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md)。

本仓库暂不提供付费托管、商业支持或 SLA。未来商业版可围绕一键安装、跨设备同步、企业连接器、团队管理和支持服务构建，而社区版继续承担非商业学习、实验和共同维护。
