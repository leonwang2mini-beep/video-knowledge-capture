# Video Knowledge Capture · 项目简报

## 定位

- 项目 ID：`P0004`
- 形态：Agent Skill + Windows 本地执行引擎
- 当前阶段：`build`
- 当前里程碑：`M8 / public-skill-community-preview`
- 许可证：PolyForm Noncommercial 1.0.0，商业使用需单独书面授权

项目解决的问题是：平台收藏和聊天链接很难进入可检索、可批注、可复用的个人知识体系。用户把一条有权处理的公开视频交给 Agent，P0004 在本机完成媒体获取、离线转写、去重和 Obsidian Inbox 写入。

## Skill-first 架构

`skills/video-knowledge-capture` 是唯一 Skill 事实源：

- Codex 和 Claude Code 安装 canonical Skill，并通过 bundled loopback client 调用本机服务；
- Hermes 安装同一 Skill，并增加两个结构化工具；
- 其他 Agent Skills 宿主可以安装到显式 Skill 目录；
- 所有入口继续复用 P0004 的单一下载、转写、去重、失败台账和写库路径。

Skill 不是云端服务，也不替代本地执行引擎。Windows 电脑、Node.js、第三方运行时和 P0004 服务必须可用。

## 当前能力

- 一个链接框完成平台识别、下载、离线 ASR、Markdown 和媒体保留；
- Bilibili 使用受限公开 API，抖音使用任务级匿名隔离浏览器，小红书要求当前完整分享链接；
- 微信视频号优先使用腾讯元宝隔离登录解析，桌面微信 sidecar 为显式启用的备用路线；
- 普通网页不能取得视频时安全降级为元数据或链接笔记；
- Hermes、Codex、Claude Code 和其他 Agent 不直接写知识库。

## 非目标

- 不处理批量抓取、批量下载、重新托管、登录绕过、浏览器资料导入或 DRM 绕过；
- 不保证会员、私有、付费、地区限制或受平台风控内容可用；
- 不开放公网端口，不提供电脑离线时的云端队列；
- 社区预览版不提供商业支持、托管服务或 SLA；
- 技术测试不替代用户对转写质量和知识价值的人工验收。

## M8 成功标准

- canonical Skill 和三类宿主安装路径通过隔离测试；
- 公共仓库完成脱敏，不包含个人路径、真实分享标识、PID 或凭据；
- 许可证、商业授权、CLA、贡献规则、第三方声明和品牌边界齐全；
- Windows CI 执行离线回归与公共发行审计；
- 新建本地 Git `main` 基线后，干净检出可完成 Skill 安装与测试；
- `SECURITY.md` 经维护者确认精确草案后写入；
- 未经单独授权，不创建远端、不推送、不发布 Release。

结构化状态和验收证据以根目录 `PROJECT.yaml` 为准。
