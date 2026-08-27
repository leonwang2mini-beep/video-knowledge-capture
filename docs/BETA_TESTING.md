# External Beta Testing · 外部 Beta 验收

本指南用于验证一名首次接触项目的用户，能否只依据 GitHub 仓库完成安装、诊断和一次真实公开视频采集。

自动测试、临时用户目录模拟和 CI 最多属于 E3。只有测试者本人完成下面的关键操作、核对 Markdown 结果并明确确认，才记录为对应宿主的 E4。

## 安全边界

- 只使用测试者有权处理的公开视频，不测试私有、付费、会员、地区限制或 DRM 内容。
- 首轮使用临时 Inbox，不写日常 Obsidian 知识库。
- 不在 Issue 中提交原始视频链接、Cookie、Token、账号信息、个人目录、原始媒体或下载器完整输出。
- `doctor:shareable` 会脱敏已知本地路径，但提交前仍必须人工检查报告。
- 电脑、本地服务和对应 Agent 必须同时在线；当前版本没有云端离线队列。

## 什么算一次有效 E4

测试者应当不是本功能的开发者，并使用干净 Windows 电脑或干净 Windows 用户配置完成以下动作：

1. 从 GitHub 获取项目，不使用维护者本机已有安装。
2. 选择一个真实宿主并完成安装：Codex、Claude Code、Hermes 或 OpenClaw。
3. `doctor` 达到 `ready`。
4. 通过该宿主提交一条有权处理的完整公开链接。
5. 收到 `completed`，并亲自打开临时 Inbox 中的 Markdown 核对标题、来源和转写内容。
6. 再次提交同一链接，确认返回 `duplicate` 且没有第二份笔记。
7. 使用 Beta 反馈模板明确确认结果。

Hermes E4 还必须从真实手机消息发起，并最终在电脑的临时 Inbox 中核对 Markdown。仅调用本机 Hermes 插件不等于手机链路 E4。

## 首装流程

操作本身约 10～15 分钟；首次下载 FFmpeg、whisper.cpp、模型和 yt-dlp 的时间另计，并取决于网络速度。

在 PowerShell 中进入仓库根目录，选择一个宿主，并创建隔离目录：

```powershell
$betaHost = "codex"
$betaRoot = Join-Path $env:TEMP "video-knowledge-capture-beta"
$betaConfig = Join-Path $betaRoot "config"
$betaInbox = Join-Path $betaRoot "vault\Inbox"
New-Item -ItemType Directory -Force -Path $betaInbox | Out-Null

npm.cmd run setup:community -- --host $betaHost --inbox $betaInbox --config-dir $betaConfig
```

`$betaHost` 可改为 `claude`、`hermes` 或 `openclaw`。不要在不需要时使用 `all`。

如果选择 Hermes，还需要按照 [README](../README.md#安装到-hermes) 启用插件，并明确授权要使用的消息渠道。安装完成后，完整退出并重新打开对应 Agent，使其重新发现 Skill。

在第一个 PowerShell 窗口启动本地服务，并保持窗口开启：

```powershell
.\start-video-capture.cmd --config-dir $betaConfig
```

在第二个 PowerShell 窗口回到仓库根目录，生成可分享的脱敏诊断：

```powershell
node scripts/doctor.mjs --shareable --host $betaHost --config-dir $betaConfig |
  Tee-Object -FilePath (Join-Path $betaRoot "doctor-shareable.json")
```

只有输出中的 `status` 为 `ready`，才继续真实采集。若为 `needs_setup`，先按照每个失败项的 `next_action` 修复，再重新运行。

## 真实任务

向对应 Agent 发送：

```text
使用 video-knowledge-capture skill，把下面这条我有权处理的公开视频收录到我的视频知识库：<完整公开链接>
```

完成后执行两次人工核对：

- 打开 `$betaInbox` 中的新 Markdown，确认内容真实存在且不是空文件；
- 再次提交同一链接，确认回执为 `duplicate`，且目录中没有生成第二份同源笔记。

不要把测试链接或生成的原始内容复制到公开 Issue。

## 提交结果

使用 [External Beta feedback](https://github.com/leonwang2mini-beep/video-knowledge-capture/issues/new?template=beta_feedback.yml) 模板提交：

- 版本、宿主和环境类型；
- 是否独立完成安装、所需时间和卡点；
- `completed`、`duplicate` 和 Markdown 人工核对结果；
- 人工检查后的 `doctor-shareable.json` 内容。

如果失败可复现，再提交 [Bug report](https://github.com/leonwang2mini-beep/video-knowledge-capture/issues/new?template=bug_report.yml)。不要因失败而改用真实知识库或提交隐私材料。

## 证据判定

| 结果 | 判定 |
| --- | --- |
| 自动测试、CI 或临时目录模拟通过 | E1–E3 技术验证，不是外部用户验收 |
| 外部用户独立首装，`doctor:shareable` 为 `ready` | 该环境的首装 E4 候选证据 |
| 外部用户完成采集、回读 Markdown、验证重复提交并确认 | 对应宿主的核心链路 E4 |
| Hermes 仅在电脑本机调用插件 | Hermes 插件 E3，不是手机消息 E4 |
| 测试者只看到成功提示，没有回读文件 | 证据不足，不计 E4 |
