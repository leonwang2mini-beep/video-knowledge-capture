# 微信视频号内容获取 · 开源方案调研

调研日期：2026-07-24；V1.0 决策复核：2026-08-21；多平台复核：2026-08-23

## Bilibili、抖音和小红书复核（M7）

已验证的上游：

- `yt-dlp/yt-dlp` 已包含 Bilibili 和 Xiaohongshu 官方提取器；小红书提取器识别带 `xsec_token` 的 explore 链接。P0004 保留受管 `yt-dlp 2026.07.04`，避免增加第二个常驻下载框架。
- `JoeanAmier/XHS-Downloader` 支持小红书作品链接、命令行和 API；项目说明明确指出 Cookie 非必需但无 Cookie 可能只能取得低清资源，同时分享链接需要在有效期内。P0004 不集成其服务或 Cookie 配置，只采纳“保留新鲜完整分享链接”的产品约束。
- `JoeanAmier/TikTokDownloader`（DouK）功能完整，但说明中浏览器 Cookie/扫码方案已弃用，签名参数也存在失效维护风险；`Evil0ctal/Douyin_TikTok_Download_API` 则明确依赖浏览器 Cookie 应对抖音风控。P0004 不要求或持久化用户 Cookie，改为每任务创建匿名隔离浏览器会话。
- `nilaoda/BBDown` 已归档且不再维护；`NanmiCoder/MediaCrawler` 依赖 Playwright 登录态，范围比“单条公开视频入库”更重，因此均不作为 P0004 运行时依赖。

M7 决策：

1. Bilibili 普通公开 BV/AV 由 P0004 内置的有界公开 API 适配器处理，绕开网页层 HTTP 412；不处理会员、登录、地区限制或 DRM。
2. 抖音使用安装在本机的 Edge/Chrome，但只创建任务目录内的全新 headless profile；仅导出 `douyin.com` 匿名 Cookie，并与该浏览器的精确 User-Agent 绑定，成功或失败都清理。
3. 小红书继续用固定版本 `yt-dlp` 和固定 impersonation；过期/缺失 `xsec_token` 映射为可安全重试的 `link-refresh-required`，不创建空 Markdown。
4. Hermes 仍只调用 P0004 loopback API，不直接运行下载器、读取浏览器或写 Obsidian。

上游地址：

- https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py
- https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py
- https://github.com/JoeanAmier/XHS-Downloader
- https://github.com/JoeanAmier/TikTokDownloader
- https://github.com/Evil0ctal/Douyin_TikTok_Download_API
- https://github.com/nilaoda/BBDown
- https://github.com/NanmiCoder/MediaCrawler

## 结论

已验证：GitHub 上存在能够从桌面微信视频号页面捕获详情或下载媒体的开源工具，但没有找到“只输入公开 `/sph/` 分享链接、无需登录态或媒体下载，即可稳定输出视频正文/字幕”的项目。

V1.0 决策：

1. 默认模式继续使用“公开元数据 + 用户粘贴文案/字幕”，保持零证书、零登录态、零媒体下载。
2. 微信高级模式采用 `wx_channel v5.7.1` 本地 sidecar；证书、启停和任务入口均需用户显式授权和操作。
3. 下游 ASR 采用原生 `whisper.cpp v1.9.2` + 多语言 small 模型，不采用 Python `faster-whisper`。权衡是 CPU 速度有限，但部署依赖更小、可执行文件与模型更容易固定版本和校验哈希。
4. HTTPS 证书安装/卸载、桌面微信捕获或视频下载不能进入普通启动路径；成功后默认删除媒体，失败时保留到重试或显式清理。

## 候选项目

### 1. `nobiyou/wx_channel`

- 地址：https://github.com/nobiyou/wx_channel
- 已验证：公开仓库、MIT License、Windows/Go、仍在发布版本。
- 已验证：需要启动 `wx_channel.exe`、安装本机 HTTPS 证书，并打开桌面微信视频号页面。
- 已验证：提供本地 HTTP API，包括连接状态、账号搜索、视频列表和视频详情端点。
- 已验证：支持视频下载、解密、去重、元数据记录与评论导出。
- 不足：不是只接收 `/sph/` 链接的无状态库；依赖桌面微信流量和代理证书，本身也不提供语音转文字。
- 判断：已选为 V1.0 显式授权 sidecar；仍不属于默认安全模式。

相关文档：

- README：https://github.com/nobiyou/wx_channel
- HTTP API：https://github.com/nobiyou/wx_channel/blob/main/docs/API_README.md

### 2. `putyy/res-downloader`

- 地址：https://github.com/putyy/res-downloader
- 已验证：公开仓库、Apache-2.0 License、Go/Wails，支持 Windows、macOS 与 Linux。
- 已验证：通过本机代理抓包发现视频号、小程序、抖音等媒体资源；首次使用需要允许安装证书和网络访问。
- 已验证：主要输出视频、音频、图片和 m3u8 等资源，视频号媒体可能还需解密。
- 不足：项目 README 明确提示维护投入有限；没有面向知识库的结构化内容或本地转写闭环。
- 判断：适合人工下载资源，不是当前应用的低风险嵌入式提取器。

### 3. `lecepin/WeChatVideoDownloader`

- 地址：https://github.com/lecepin/WeChatVideoDownloader
- 已验证：微信视频号下载器，曾有较高使用量。
- 已验证：仓库已于 2024-05-15 归档，只读，最近发布停留在 2023 年。
- 判断：不作为新集成基础。

### 4. `imlewc/video-to-subtitle-summary-skill`

- 地址：https://github.com/imlewc/video-to-subtitle-summary-skill
- 已验证：MIT License；支持本地 `faster-whisper`，也支持可选的火山引擎转写。
- 已验证：在线链接重点支持抖音、小红书、B 站和 YouTube；本地文件模式可直接转写音视频。
- 已验证：依赖 FFmpeg；部分平台解析需要第三方 API Key，`faster-whisper` 首次运行需下载模型。
- 不足：没有声明支持微信视频号分享链接，也不能替代微信媒体获取层。
- 判断：适合作为未来 M5 的下游本地 ASR 参考，不直接集成当前 `/sph/` 链接入口。

## 推荐的未来架构

```text
显式启用高级模式
  → wx_channel 本地 sidecar
  → 用户在桌面微信打开目标视频
  → 本地 API 返回详情并在授权后保存媒体
  → FFmpeg 提取音频
  → FFmpeg 8.1.2 提取 16 kHz 单声道 WAV
  → whisper.cpp 1.9.2 + multilingual small 本地转写
  → 视频知识捕手写入受控“视频内容”区
  → 删除或保留临时媒体（由用户明确选择）
```

## 安全与产品影响

- 对用户：高级模式可减少手工粘贴，但首次配置复杂，会安装根证书、使用微信进程代理并占用本地转写算力。
- 对业务：可把“视频书签”升级成“可检索内容”，同时带来平台兼容、版权和隐私责任。
- 对维护者：微信协议与桌面端变化频繁，sidecar 版本、证书卸载、代理恢复、媒体清理和 ASR 模型都需要独立健康检查与失败台账。
- 决策门槛：证书安装/卸载、桌面微信捕获、下载解密、本地转写和成功清理必须由当前用户明确授权。真实视频 E4 仍需用户主动打开有权处理的目标视频；技术启动或模拟测试不能替代该确认。

## 固定运行时来源

- `wx_channel v5.7.1`：GitHub Release `wx_channel_v5.7.1.zip`，SHA-256 `c17370359bb31b040e7cb527c83ad9d1d0174f90c1205f120ef36aeec2b4178b`
- `whisper.cpp v1.9.2`：GitHub Release `whisper-bin-x64.zip`，SHA-256 `49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`
- `ggml-small.bin`：whisper.cpp 多语言模型，SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`
- `FFmpeg 8.1.2 essentials`：Gyan Windows build，SHA-256 `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`

安装器只写 `%LOCALAPPDATA%\VideoKnowledgeCapture\runtime`，下载时校验上述摘要，仓库不提交第三方二进制或模型。
