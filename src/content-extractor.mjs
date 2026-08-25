import { lookup as lookupDns } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GENERIC_TITLES = new Set([
  "bilibili",
  "douyin",
  "wechat",
  "weixin",
  "youtube",
  "哔哩哔哩",
  "微信",
  "微信视频号",
  "抖音",
  "视频号",
]);

const IPV4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_BLOCKS = [
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
];

export class ContentExtractionError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "ContentExtractionError";
    this.code = code;
  }
}

function extractionError(message, code, cause) {
  return new ContentExtractionError(message, code, { cause });
}

function parseIpv4(address) {
  if (isIP(address) !== 4) {
    return null;
  }
  return address
    .split(".")
    .reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function parseIpv6(address) {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (isIP(normalized) !== 6) {
    return null;
  }

  let source = normalized;
  const ipv4Match = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (ipv4 === null) {
      return null;
    }
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    source = source.slice(0, -ipv4Match[1].length) + `${high}:${low}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }
  const parts = halves.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (parts.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const part of parts) {
    const parsed = Number.parseInt(part || "0", 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
      return null;
    }
    value = (value << 16n) + BigInt(parsed);
  }
  return value;
}

function isInSubnet(value, network, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (network >> shift);
}

function isPublicIpv4(address) {
  const value = parseIpv4(address);
  if (value === null) {
    return false;
  }
  return !IPV4_BLOCKS.some(([networkAddress, prefix]) => {
    return isInSubnet(value, parseIpv4(networkAddress), prefix, 32);
  });
}

function isPublicIpv6(address) {
  const value = parseIpv6(address);
  if (value === null) {
    return false;
  }

  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const ipv4 = [
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ].join(".");
    return isPublicIpv4(ipv4);
  }

  const globalNetwork = parseIpv6("2000::");
  if (!isInSubnet(value, globalNetwork, 3, 128)) {
    return false;
  }
  return !IPV6_BLOCKS.some(([networkAddress, prefix]) => {
    return isInSubnet(value, parseIpv6(networkAddress), prefix, 128);
  });
}

export function isPublicIpAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, "").split("%", 1)[0];
  const family = isIP(normalized);
  if (family === 4) {
    return isPublicIpv4(normalized);
  }
  if (family === 6) {
    return isPublicIpv6(normalized);
  }
  return false;
}

export function validatePublicPageUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch (error) {
    throw extractionError("公开页面地址不是有效 URL。", "INVALID_PUBLIC_URL", error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw extractionError("公开页面只允许 http/https。", "UNSUPPORTED_PUBLIC_PROTOCOL");
  }
  if (url.username || url.password) {
    throw extractionError("公开页面地址不得包含用户名或密码。", "PUBLIC_URL_CREDENTIALS");
  }
  if (
    (url.protocol === "http:" && url.port && url.port !== "80")
    || (url.protocol === "https:" && url.port && url.port !== "443")
  ) {
    throw extractionError("公开页面只允许标准 HTTP/HTTPS 端口。", "PUBLIC_PORT_BLOCKED");
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
  ) {
    throw extractionError("已阻止访问本机或内部网络地址。", "PRIVATE_ADDRESS_BLOCKED");
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw extractionError("已阻止访问本机、私网或保留地址。", "PRIVATE_ADDRESS_BLOCKED");
  }
  return url;
}

async function resolvePublicAddresses(hostname, lookup = lookupDns) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(normalized);
  let addresses;
  try {
    addresses = literalFamily
      ? [{ address: normalized, family: literalFamily }]
      : await lookup(normalized, { all: true, verbatim: true });
  } catch (error) {
    throw extractionError("无法解析公开页面域名。", "PUBLIC_DNS_FAILED", error);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw extractionError("公开页面域名没有可用地址。", "PUBLIC_DNS_EMPTY");
  }
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw extractionError(
      "公开页面域名解析到本机、私网或保留地址，已停止读取。",
      "PRIVATE_ADDRESS_BLOCKED",
    );
  }
  return addresses;
}

function normalizeHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function defaultRequestTransport({
  address,
  maxBytes,
  timeoutMs,
  url,
}) {
  return new Promise((resolve, reject) => {
    const requestModule = url.protocol === "https:" ? https : http;
    const request = requestModule.request({
      family: address.family,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "VideoKnowledgeCapture/0.4 (+public metadata only)",
      },
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      lookup(_hostname, options, callback) {
        const done = typeof options === "function" ? options : callback;
        done(null, address.address, address.family);
      },
      method: "GET",
      path: `${url.pathname}${url.search}`,
      port: url.port || undefined,
      protocol: url.protocol,
      servername: url.protocol === "https:" ? url.hostname.replace(/^\[|\]$/g, "") : undefined,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(extractionError(
            `公开页面超过 ${maxBytes} 字节限制。`,
            "PUBLIC_RESPONSE_TOO_LARGE",
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode ?? 0,
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(extractionError("公开页面读取超时。", "PUBLIC_FETCH_TIMEOUT"));
    });
    request.once("error", (error) => {
      reject(error instanceof ContentExtractionError
        ? error
        : extractionError("无法读取公开页面。", "PUBLIC_FETCH_FAILED", error));
    });
    request.end();
  });
}

function decodeBody(body, contentType) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function decodeContentEncoding(body, contentEncoding, maxBytes) {
  const encoding = String(contentEncoding ?? "identity").trim().toLowerCase();
  if (!encoding || encoding === "identity") {
    return body;
  }

  let decoded;
  try {
    const options = { maxOutputLength: maxBytes };
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = gunzipSync(body, options);
    } else if (encoding === "deflate") {
      decoded = inflateSync(body, options);
    } else if (encoding === "br") {
      decoded = brotliDecompressSync(body, options);
    } else {
      throw extractionError(
        `公开页面使用了不支持的内容编码：${encoding}。`,
        "PUBLIC_CONTENT_ENCODING",
      );
    }
  } catch (error) {
    if (error instanceof ContentExtractionError) {
      throw error;
    }
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /larger than/i.test(error?.message ?? "")) {
      throw extractionError(
        `公开页面解压后超过 ${maxBytes} 字节限制。`,
        "PUBLIC_RESPONSE_TOO_LARGE",
        error,
      );
    }
    throw extractionError("公开页面内容解压失败。", "PUBLIC_DECOMPRESSION_FAILED", error);
  }
  if (decoded.length > maxBytes) {
    throw extractionError(
      `公开页面解压后超过 ${maxBytes} 字节限制。`,
      "PUBLIC_RESPONSE_TOO_LARGE",
    );
  }
  return decoded;
}

export async function fetchPublicHtml(value, {
  lookup = lookupDns,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transport = defaultRequestTransport,
} = {}) {
  let url = validatePublicPageUrl(value);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(url.hostname, lookup);
    const response = await transport({
      address: addresses[0],
      maxBytes,
      timeoutMs,
      url,
    });
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(String(response.body ?? ""), "utf8");
    if (body.length > maxBytes) {
      throw extractionError(
        `公开页面超过 ${maxBytes} 字节限制。`,
        "PUBLIC_RESPONSE_TOO_LARGE",
      );
    }

    const statusCode = Number(response.statusCode ?? 0);
    if (REDIRECT_STATUSES.has(statusCode)) {
      const location = normalizeHeaderValue(response.headers?.location);
      if (!location) {
        throw extractionError("公开页面重定向缺少目标地址。", "PUBLIC_REDIRECT_INVALID");
      }
      if (redirectCount === maxRedirects) {
        throw extractionError("公开页面重定向次数过多。", "PUBLIC_REDIRECT_LIMIT");
      }
      url = validatePublicPageUrl(new URL(location, url));
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw extractionError(
        `公开页面返回 HTTP ${statusCode || "未知"}。`,
        "PUBLIC_HTTP_STATUS",
      );
    }
    const contentType = String(normalizeHeaderValue(response.headers?.["content-type"]) ?? "");
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType.trim())) {
      throw extractionError("公开地址返回的不是 HTML 页面。", "PUBLIC_CONTENT_TYPE");
    }
    const decodedBody = decodeContentEncoding(
      body,
      normalizeHeaderValue(response.headers?.["content-encoding"]),
      maxBytes,
    );
    return {
      contentType,
      finalUrl: url.toString(),
      html: decodeBody(decodedBody, contentType),
      statusCode,
    };
  }

  throw extractionError("公开页面重定向次数过多。", "PUBLIC_REDIRECT_LIMIT");
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["nbsp", " "],
    ["quot", "\""],
  ]);
  return String(value ?? "").replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
    (entity, decimal, hexadecimal, name) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      return named.get(String(name).toLowerCase()) ?? entity;
    },
  );
}

function normalizeText(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseAttributes(tag) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1].replace(/^</, "").toLowerCase();
    if (name === "meta" || name === "link" || name === "script") {
      continue;
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function readMetaValues(html) {
  const values = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = (
      attributes.get("property")
      || attributes.get("name")
      || attributes.get("itemprop")
      || ""
    ).toLowerCase();
    const content = attributes.get("content");
    if (key && content !== undefined && !values.has(key)) {
      values.set(key, content);
    }
  }
  return values;
}

function firstValue(values, keys) {
  for (const key of keys) {
    if (values.has(key)) {
      return values.get(key);
    }
  }
  return null;
}

function extractJsonLd(html) {
  const candidates = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = parseAttributes(`<script ${match[1]}>`);
    if (!String(attributes.get("type") ?? "").toLowerCase().includes("ld+json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(match[2].trim());
      candidates.push(parsed);
    } catch {
      // A broken JSON-LD block must not invalidate otherwise useful HTML metadata.
    }
  }

  const objects = [];
  function visit(value, depth = 0) {
    if (depth > 6 || objects.length >= 100 || value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    objects.push(value);
    for (const entry of Object.values(value)) {
      visit(entry, depth + 1);
    }
  }
  for (const candidate of candidates) {
    visit(candidate);
  }

  const preferredTypes = new Set([
    "article",
    "creativework",
    "newsarticle",
    "socialmediaposting",
    "videoobject",
  ]);
  return objects.find((object) => {
    const types = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
    return types.some((type) => preferredTypes.has(String(type).toLowerCase()));
  }) ?? objects[0] ?? null;
}

function readJsonLdAuthor(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") {
    return first;
  }
  if (first && typeof first === "object") {
    return first.name ?? first.alternateName ?? null;
  }
  return null;
}

function canonicalLink(html, pageUrl) {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const relations = String(attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!relations.includes("canonical") || !attributes.get("href")) {
      continue;
    }
    try {
      return new URL(attributes.get("href"), pageUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function usefulTitle(value) {
  const title = normalizeText(value, 300);
  if (!title) {
    return null;
  }
  const comparable = title.toLowerCase().replace(/[|｜·•\-—_]+$/g, "").trim();
  return GENERIC_TITLES.has(comparable) ? null : title;
}

export function parsePublicMetadata(html, { pageUrl } = {}) {
  const source = String(html ?? "");
  const meta = readMetaValues(source);
  const jsonLd = extractJsonLd(source);
  const titleTag = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;

  const title = usefulTitle(
    firstValue(meta, ["og:title", "twitter:title"])
      ?? jsonLd?.name
      ?? jsonLd?.headline
      ?? titleTag,
  );
  const author = normalizeText(
    firstValue(meta, ["author", "article:author", "og:article:author", "twitter:creator"])
      ?? readJsonLdAuthor(jsonLd?.author),
    200,
  );
  const description = normalizeText(
    firstValue(meta, ["og:description", "twitter:description", "description"])
      ?? jsonLd?.description,
    1200,
  );
  const siteName = normalizeText(
    firstValue(meta, ["og:site_name", "application-name"])
      ?? jsonLd?.publisher?.name,
    200,
  );
  const publishedAt = normalizeText(
    firstValue(meta, ["article:published_time", "og:published_time"])
      ?? jsonLd?.uploadDate
      ?? jsonLd?.datePublished,
    100,
  );

  return {
    author,
    canonicalUrl: pageUrl ? canonicalLink(source, pageUrl) : null,
    description,
    publishedAt,
    siteName,
    title,
  };
}

function unavailableContent(code, message, extra = {}) {
  return {
    author: null,
    canonicalUrl: null,
    description: null,
    errorCode: code,
    errorMessage: message,
    fieldCount: 0,
    publishedAt: null,
    resolvedUrl: extra.resolvedUrl ?? null,
    siteName: null,
    status: "unavailable",
    strategy: "public-html",
    title: null,
  };
}

export async function extractPublicMetadata({
  canonicalUrl,
}, {
  fetchHtml = fetchPublicHtml,
  fetchOptions,
} = {}) {
  let fetched;
  try {
    fetched = await fetchHtml(canonicalUrl, fetchOptions);
    const metadata = parsePublicMetadata(fetched.html, { pageUrl: fetched.finalUrl });
    const fieldCount = [
      metadata.title,
      metadata.author,
      metadata.description,
      metadata.publishedAt,
    ].filter(Boolean).length;
    if (fieldCount === 0) {
      return unavailableContent(
        "NO_USEFUL_METADATA",
        "公开页面可访问，但没有可用的标题、作者或简介。",
        { resolvedUrl: fetched.finalUrl },
      );
    }
    return {
      ...metadata,
      errorCode: null,
      errorMessage: null,
      fieldCount,
      resolvedUrl: fetched.finalUrl,
      status: "extracted",
      strategy: "public-html",
    };
  } catch (error) {
    const code = error instanceof ContentExtractionError
      ? error.code
      : "CONTENT_EXTRACTION_FAILED";
    const message = error instanceof ContentExtractionError
      ? error.message
      : "公开页面信息提取失败。";
    return unavailableContent(code, message, {
      resolvedUrl: fetched?.finalUrl ?? null,
    });
  }
}
