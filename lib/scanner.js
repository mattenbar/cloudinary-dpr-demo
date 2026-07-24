/**
 * Page scanner helpers: URL validation, Cloudinary URL extraction, candidate ordering.
 * DOMParser-dependent helpers degrade gracefully in Node.
 */

import {
  parseCloudinaryUrl,
  getScannedUrlRecommendation,
  buildScrapedLayoutContext
} from "./cloudinary-audit.js";

export const DOMAIN_READER_ORIGIN = "https://r.jina.ai/";
export const DOMAIN_SCAN_DEFAULT_LIMIT = 5;

export const SAMPLE_SCAN_PAGES = [
  {
    label: "Cloudinary responsive docs",
    url: "https://cloudinary.com/documentation/responsive_images"
  },
  {
    label: "Cloudinary image optimization",
    url: "https://cloudinary.com/documentation/image_optimization"
  }
];

const isPrivateIpv4Parts = (ipv4) =>
  ipv4[0] === 0
  || ipv4[0] === 10
  || ipv4[0] === 127
  || (ipv4[0] === 169 && ipv4[1] === 254)
  || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
  || (ipv4[0] === 192 && ipv4[1] === 168);

const parseIpv4Hostname = (hostname) => {
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ipv4;
};

/** Expand ::ffff:7f00:1 (and dotted ::ffff:127.0.0.1) to IPv4 parts. */
const parseIpv4MappedIpv6 = (hostname) => {
  const dotted = hostname.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (dotted) return parseIpv4Hostname(dotted[1]);

  const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255];
};

export const isPrivatePageHostname = (rawHostname) => {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname === "::1") return true;

  const mappedIpv4 = parseIpv4MappedIpv6(hostname);
  if (mappedIpv4) return isPrivateIpv4Parts(mappedIpv4);

  // IPv6 ULA / link-local — only when the hostname is address-shaped (contains ":").
  if (hostname.includes(":")) {
    if (/^f[cd][0-9a-f]{2}:/i.test(hostname) || /^fe80:/i.test(hostname)) return true;
  }

  const ipv4 = parseIpv4Hostname(hostname);
  if (!ipv4) return false;
  return isPrivateIpv4Parts(ipv4);
};

export const normalizePageUrl = (rawValue) => {
  const trimmed = rawValue.trim();
  if (!trimmed) throw new Error("Enter the public webpage URL you want to scan.");
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let pageUrl;
  try {
    pageUrl = new URL(withProtocol);
  } catch {
    throw new Error("Enter a complete webpage URL, such as https://www.example.com/page.");
  }
  if (!/^https?:$/.test(pageUrl.protocol)) throw new Error("Only public HTTP or HTTPS webpages can be scanned.");
  if (pageUrl.username || pageUrl.password) throw new Error("URLs containing usernames or passwords are not accepted.");
  if (isPrivatePageHostname(pageUrl.hostname)) throw new Error("Private and local network addresses cannot be scanned.");
  pageUrl.hash = "";
  return pageUrl;
};

export const getCanonicalPageUrl = (readerData, fallbackUrl) => {
  const canonicalCandidates = [
    ...Object.keys(readerData?.external?.canonical || {}),
    readerData?.metadata?.["og:url"]
  ].filter(Boolean);

  for (const candidate of canonicalCandidates) {
    try {
      return normalizePageUrl(candidate);
    } catch {
      // Ignore missing, malformed, or non-public canonical metadata.
    }
  }
  return fallbackUrl;
};

export const fetchReaderData = async (pageUrl, { metadataOnly = false, signal, fetchImpl = fetch } = {}) => {
  const response = await fetchImpl(`${DOMAIN_READER_ORIGIN}${pageUrl.href}`, {
    headers: metadataOnly
      ? {
          Accept: "application/json",
          "X-No-Cache": "true",
          "X-Engine": "curl",
          "X-Respond-Timing": "html",
          "X-Timeout": "8"
        }
      : {
          Accept: "application/json",
          "X-No-Cache": "true",
          "X-Engine": "browser",
          "X-Respond-Timing": "network-idle",
          "X-Respond-With": "markdown+frontmatter",
          "X-With-Images-Summary": "all",
          "X-Timeout": "20"
        },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal
  });

  if (!response.ok) {
    const error = response.status === 429
      ? new Error("The page reader rate limit was reached. Wait a minute and try again.")
      : new Error(`The page reader returned HTTP ${response.status}. This page may block automated access.`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  if (!payload?.data) throw new Error("The page reader returned an incomplete browser snapshot.");
  return payload.data;
};

export const fetchReaderHtml = async (pageUrl, { signal, fetchImpl = fetch } = {}) => {
  const response = await fetchImpl(`${DOMAIN_READER_ORIGIN}${pageUrl.href}`, {
    headers: {
      Accept: "application/json",
      "X-No-Cache": "true",
      "X-Engine": "curl",
      "X-Respond-With": "html",
      "X-Timeout": "8"
    },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal
  });
  if (!response.ok) {
    const error = new Error(`The HTML pass returned HTTP ${response.status}, so client-side helper detection may be incomplete.`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  return payload?.data?.html || payload?.data?.content || "";
};

export const stripMarkdownUrlDelimiter = (candidate) => {
  let parenthesisDepth = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === "(") {
      parenthesisDepth += 1;
    } else if (candidate[index] === ")") {
      if (parenthesisDepth === 0) return candidate.slice(0, index);
      parenthesisDepth -= 1;
    }
  }
  return candidate;
};

export const extractCloudinaryImageUrls = (content) => {
  const normalized = content
    .replace(/\\\//g, "/")
    .replace(/&amp;|&#38;|&#x26;/gi, "&")
    .replace(/&quot;|&#34;|&#x22;/gi, '"');
  const candidates = normalized.match(/(?:https?:)?\/\/[^\s<>"'`\\]+/gi) || [];
  const unique = new Map();

  candidates.forEach((candidate) => {
    const withoutMarkdownDelimiter = stripMarkdownUrlDelimiter(candidate);
    const cleaned = withoutMarkdownDelimiter.replace(/[\]}>.,;]+$/g, "");
    const absolute = cleaned.startsWith("//") ? `https:${cleaned}` : cleaned;
    try {
      const url = new URL(absolute);
      if (!/^https?:$/.test(url.protocol) || !/\/image\/upload\//.test(url.pathname)) return;
      url.hash = "";
      unique.set(url.href, url.href);
    } catch {
      // Ignore text fragments that resemble URLs but cannot be parsed.
    }
  });

  return [...unique.values()];
};

export const normalizeScrapedAssetUrl = (rawUrl, pageUrl) => {
  try {
    const url = new URL(rawUrl, pageUrl);
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
};

export const extractSrcsetUrls = (srcset) => {
  const urls = [];
  const matcher = /((?:https?:)?\/\/\S+?)(?=\s+\d+(?:\.\d+)?[wx](?:\s*,|$))/gi;
  let match;
  while ((match = matcher.exec(srcset))) urls.push(match[1]);
  return urls;
};

export const extractScrapedImageElements = (html, pageUrl) => {
  const elements = new Map();
  if (!html || typeof DOMParser === "undefined") return elements;
  const documentSnapshot = new DOMParser().parseFromString(html, "text/html");

  documentSnapshot.querySelectorAll("img").forEach((image, pageIndex) => {
    const sources = [
      image.getAttribute("src"),
      image.getAttribute("data-src"),
      image.getAttribute("data-lazy-src"),
      image.getAttribute("data-original"),
      ...extractSrcsetUrls(image.getAttribute("srcset") || ""),
      ...[...(image.closest("picture")?.querySelectorAll("source[srcset]") || [])]
        .flatMap((source) => extractSrcsetUrls(source.getAttribute("srcset") || ""))
    ].filter(Boolean);
    const ancestorClasses = [];
    let layoutColumnCount = 0;
    let layoutBreakpoint = "";
    let ancestor = image.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor.className && typeof ancestor.className === "string") {
        ancestorClasses.push(ancestor.className);
        if (!layoutColumnCount) {
          const flexMatch = ancestor.className.match(/(?:^|\s)(?:(sm|md|lg|xl|2xl):)?flex-row(?:\s|$)/);
          const gridMatch = ancestor.className.match(/(?:^|\s)(?:(sm|md|lg|xl|2xl):)?grid-cols-(\d+)(?:\s|$)/);
          if (flexMatch && ancestor.children.length > 1) {
            layoutColumnCount = ancestor.children.length;
            layoutBreakpoint = flexMatch[1] || "";
          } else if (gridMatch) {
            layoutColumnCount = Number(gridMatch[2]);
            layoutBreakpoint = gridMatch[1] || "";
          }
        }
      }
    }
    const context = {
      pageIndex,
      widthAttribute: image.getAttribute("width") || "",
      heightAttribute: image.getAttribute("height") || "",
      sizes: image.getAttribute("sizes") || "",
      styleWidth: image.style.width || "",
      styleHeight: image.style.height || "",
      styleMaxWidth: image.style.maxWidth || "",
      styleAspectRatio: image.style.aspectRatio || "",
      className: typeof image.className === "string" ? image.className : "",
      ancestorClasses: ancestorClasses.join(" "),
      layoutColumnCount,
      layoutBreakpoint
    };

    sources.forEach((source) => {
      const normalized = normalizeScrapedAssetUrl(source, pageUrl);
      if (/\/image\/upload\//.test(normalized) && !elements.has(normalized)) elements.set(normalized, context);
    });
  });

  return elements;
};

export const detectCloudinaryClientSideHelper = (html, { unavailableReason = "" } = {}) => {
  if (!html) {
    return {
      status: "unknown",
      evidence: unavailableReason
        || "The source HTML was unavailable, so helper presence could not be verified."
    };
  }

  if (typeof DOMParser === "undefined") {
    const helperSourcePattern = /(?:cloudinary-core|cloudinary-js|@cloudinary\/(?:html|url-gen)|next-cloudinary|cloudinary(?:\.min)?\.js)/i;
    const helperCodePattern = /(?:cloudinary_update\s*\(|\.cloudinary_update\s*\(|Cloudinary\.new\s*\(|new\s+Cloudinary(?:Image|Video)?\s*\()/i;
    if (helperSourcePattern.test(html) || helperCodePattern.test(html)) {
      return {
        status: "detected",
        evidence: "Detected Cloudinary helper references in the retrieved HTML source."
      };
    }
    return {
      status: "missing",
      evidence: "No known Cloudinary client-side helper script or initialization call was detected in the scraped page HTML."
    };
  }

  const documentSnapshot = new DOMParser().parseFromString(html, "text/html");
  const helperSourcePattern = /(?:cloudinary-core|cloudinary-js|@cloudinary\/(?:html|url-gen)|next-cloudinary|cloudinary(?:\.min)?\.js)/i;
  const helperCodePattern = /(?:cloudinary_update\s*\(|\.cloudinary_update\s*\(|Cloudinary\.new\s*\(|new\s+Cloudinary(?:Image|Video)?\s*\()/i;
  const scripts = [...documentSnapshot.querySelectorAll("script")];
  const sourceMatch = scripts.find((script) => helperSourcePattern.test(script.getAttribute("src") || ""));
  if (sourceMatch) {
    return {
      status: "detected",
      evidence: `Detected helper script: ${sourceMatch.getAttribute("src")}`
    };
  }

  const inlineMatch = scripts.find((script) => helperCodePattern.test(script.textContent || ""));
  if (inlineMatch) {
    return {
      status: "detected",
      evidence: "Detected Cloudinary helper initialization in an inline page script."
    };
  }

  return {
    status: "missing",
    evidence: "No known Cloudinary client-side helper script or initialization call was detected in the scraped page HTML."
  };
};

export const describeScannedCloudinaryUrl = (url, recommendation = getScannedUrlRecommendation(url)) => {
  try {
    const parsed = parseCloudinaryUrl(url);
    return recommendation
      ? `${parsed.url.hostname} · ${recommendation.dprLabel} · ${recommendation.title}`
      : `${parsed.url.hostname} · No optimization recommendation`;
  } catch {
    try {
      return new URL(url).hostname;
    } catch {
      return "Unknown host";
    }
  }
};

export const orderDomainScanCandidates = (candidates, order) => {
  const ordered = [...candidates];
  const byFoundOrder = (first, second) => first.foundOrder - second.foundOrder;
  if (order === "page-desc") return ordered.sort((first, second) => second.foundOrder - first.foundOrder);
  if (order === "page-asc") return ordered.sort(byFoundOrder);
  if (order === "potential-asc") {
    return ordered.sort((first, second) => first.recommendation.score - second.recommendation.score || byFoundOrder(first, second));
  }
  return ordered.sort((first, second) => second.recommendation.score - first.recommendation.score || byFoundOrder(first, second));
};

export const buildScanCandidates = (content, pageHtml, pageUrl, { htmlUnavailableReason = "" } = {}) => {
  const pageImageElements = extractScrapedImageElements(pageHtml, pageUrl);
  const clientSideHelper = detectCloudinaryClientSideHelper(pageHtml, {
    unavailableReason: htmlUnavailableReason
  });
  return extractCloudinaryImageUrls(content)
    .map((url) => {
      const elementContext = pageImageElements.get(normalizeScrapedAssetUrl(url));
      const layout = buildScrapedLayoutContext(url, elementContext);
      return { url, layout, clientSideHelper, recommendation: getScannedUrlRecommendation(url, layout) };
    })
    .filter((candidate) => candidate.recommendation)
    .map((candidate, foundOrder) => ({ ...candidate, foundOrder }));
};
