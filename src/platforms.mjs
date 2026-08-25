const PLATFORM_RULES = [
  {
    id: "douyin",
    label: "抖音",
    domains: ["douyin.com", "iesdouyin.com"],
  },
  {
    id: "wechat-channels",
    label: "微信视频号",
    domains: ["channels.weixin.qq.com", "finder.video.qq.com"],
  },
  {
    id: "wechat",
    label: "微信",
    domains: ["weixin.qq.com"],
  },
  {
    id: "bilibili",
    label: "哔哩哔哩",
    domains: ["bilibili.com", "b23.tv"],
  },
  {
    id: "kuaishou",
    label: "快手",
    domains: ["kuaishou.com", "gifshow.com"],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    domains: ["xiaohongshu.com", "xhslink.com"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    domains: ["tiktok.com"],
  },
  {
    id: "youtube",
    label: "YouTube",
    domains: ["youtube.com", "youtu.be"],
  },
  {
    id: "tencent-video",
    label: "腾讯视频",
    domains: ["v.qq.com"],
  },
];

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectPlatform(urlValue) {
  const url = urlValue instanceof URL ? urlValue : new URL(urlValue);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    matchesDomain(hostname, "weixin.qq.com")
    && /^\/sph(?:\/|$)/i.test(url.pathname)
  ) {
    return { id: "wechat-channels", label: "微信视频号" };
  }

  for (const platform of PLATFORM_RULES) {
    if (platform.domains.some((domain) => matchesDomain(hostname, domain))) {
      return { id: platform.id, label: platform.label };
    }
  }

  return { id: "web", label: "网页" };
}
