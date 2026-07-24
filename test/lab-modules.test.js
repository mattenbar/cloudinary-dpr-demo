import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatBytes,
  formatBandwidth,
  formatDelta,
  getResourceDetails
} from "../lib/measurements.js";
import {
  selectSmallestTransfers,
  selectDeviceRecommendation,
  buildDeviceRecommendationReason,
  RECEIPT_LABELS
} from "../lib/receipt.js";
import {
  isPrivatePageHostname,
  normalizePageUrl,
  extractCloudinaryImageUrls,
  orderDomainScanCandidates,
  detectCloudinaryClientSideHelper,
  stripMarkdownUrlDelimiter
} from "../lib/scanner.js";
import { parseLabQuery, buildLabQuery, safeDecodeURIComponent } from "../lib/deep-links.js";
import {
  buildFluidMarkup,
  buildResolvedFluidPreviewUrl,
  buildFluidAutomaticUrl,
  roundFluidWidth
} from "../lib/fluid-urls.js";
import { isChromiumBrowser } from "../lib/browser.js";
import { buildAudit, parseCloudinaryUrl } from "../lib/cloudinary-audit.js";

const sample = (transforms, publicId = "sample.jpg") =>
  `https://res.cloudinary.com/demo/image/upload/${transforms}/v1/${publicId}`;

describe("measurements formatters", () => {
  it("formats bytes and bandwidth", () => {
    assert.equal(formatBytes(0), "Unavailable");
    assert.equal(formatBytes(512), "512 B");
    assert.match(formatBytes(1536), /KB/);
    assert.equal(formatBandwidth({ wasCached: true, transferBytes: 0 }), "Cached (0 B transfer)");
    assert.equal(formatBandwidth({ transferBytes: 2048 }), formatBytes(2048));
  });

  it("formats deltas against the original", () => {
    assert.equal(formatDelta(100, 100, true), "Baseline");
    assert.match(formatDelta(50, 100), /−/);
    assert.match(formatDelta(150, 100), /\+/);
  });

  it("reads Cloudinary content-info from Resource Timing", () => {
    const details = getResourceDetails("https://example.com/a.jpg", {
      getEntriesByName: () => [{
        encodedBodySize: 1200,
        transferSize: 1300,
        serverTiming: [{ name: "content-info", description: "width=720,height=480,bytes=1200" }]
      }]
    });
    assert.equal(details.width, 720);
    assert.equal(details.height, 480);
    assert.equal(details.bytes, 1200);
    assert.equal(details.transferBytes, 1300);
    assert.equal(details.wasCached, false);
  });

  it("marks cache hits only when Timing exposes a body with zero transfer", () => {
    const cached = getResourceDetails("https://example.com/cached.jpg", {
      getEntriesByName: () => [{
        encodedBodySize: 900,
        transferSize: 0,
        serverTiming: []
      }]
    });
    assert.equal(cached.wasCached, true);
    assert.equal(cached.bytes, 900);

    const opaqueCrossOrigin = getResourceDetails("https://example.com/opaque.jpg", {
      getEntriesByName: () => [{
        encodedBodySize: 0,
        transferSize: 0,
        serverTiming: [{ name: "content-info", description: "width=360,height=240,bytes=1100" }]
      }]
    });
    assert.equal(opaqueCrossOrigin.wasCached, false);
    assert.equal(opaqueCrossOrigin.bytes, 1100);
    assert.equal(opaqueCrossOrigin.transferBytes, 0);
  });
});

describe("receipt ranking", () => {
  it("prefers complete network transfers for smallest transfer", () => {
    const metrics = new Map([
      ["original", { bytes: 5000, transferBytes: 5100 }],
      ["baseline", { bytes: 1000, transferBytes: 1100 }],
      ["fixed", { bytes: 2000, transferBytes: 900 }],
      ["auto", { bytes: 1500, transferBytes: 1600 }]
    ]);
    const result = selectSmallestTransfers(metrics);
    assert.deepEqual(result.keys, ["fixed"]);
    assert.equal(result.hasCompleteNetworkTransfers, true);
    assert.equal(result.labels[0], RECEIPT_LABELS.fixed);
  });

  it("falls back to encoded bytes when transfers are incomplete", () => {
    const metrics = new Map([
      ["original", { bytes: 5000, transferBytes: 0 }],
      ["baseline", { bytes: 800, transferBytes: 0 }],
      ["fixed", { bytes: 2000, transferBytes: 0 }],
      ["auto", { bytes: 1200, transferBytes: 0 }]
    ]);
    const result = selectSmallestTransfers(metrics);
    assert.deepEqual(result.keys, ["baseline"]);
    assert.equal(result.hasCompleteNetworkTransfers, false);
  });

  it("recommends the smallest strategy that meets the device DPR target", () => {
    const metrics = new Map([
      ["baseline", { bytes: 800, naturalWidth: 360 }],
      ["fixed", { bytes: 1800, naturalWidth: 720 }],
      ["auto", { bytes: 1600, naturalWidth: 720 }]
    ]);
    const result = selectDeviceRecommendation(metrics, { targetDpr: 2, baseWidth: 360 });
    assert.equal(result.selectedKey, "auto");
    assert.equal(result.qualified, true);
    assert.equal(result.automaticMissedTarget, false);
    assert.match(
      buildDeviceRecommendationReason(result.qualified, 2),
      /smallest measured response that meets/
    );
  });

  it("explains when no strategy meets the device DPR target", () => {
    const metrics = new Map([
      ["baseline", { bytes: 800, naturalWidth: 360 }],
      ["fixed", { bytes: 900, naturalWidth: 360 }],
      ["auto", { bytes: 850, naturalWidth: 360 }]
    ]);
    const result = selectDeviceRecommendation(metrics, { targetDpr: 2, baseWidth: 360 });
    assert.equal(result.qualified, false);
    assert.match(
      buildDeviceRecommendationReason(result.qualified, 2),
      /No measured strategy reached/
    );
  });

  it("flags automatic DPR when live output misses the target", () => {
    const metrics = new Map([
      ["baseline", { bytes: 800, naturalWidth: 360 }],
      ["fixed", { bytes: 1800, naturalWidth: 720 }],
      ["auto", { bytes: 900, naturalWidth: 360 }]
    ]);
    const result = selectDeviceRecommendation(metrics, { targetDpr: 2, baseWidth: 360 });
    assert.equal(result.selectedKey, "fixed");
    assert.equal(result.automaticMissedTarget, true);
    assert.equal(result.autoDeliveredDpr, 1);
  });
});

describe("scanner helpers", () => {
  it("rejects private and local hostnames", () => {
    assert.equal(isPrivatePageHostname("localhost"), true);
    assert.equal(isPrivatePageHostname("127.0.0.1"), true);
    assert.equal(isPrivatePageHostname("192.168.1.10"), true);
    assert.equal(isPrivatePageHostname("10.0.0.5"), true);
    assert.equal(isPrivatePageHostname("cloudinary.com"), false);
  });

  it("allows public domains that only look like IPv6 ULA prefixes", () => {
    assert.equal(isPrivatePageHostname("fc.com"), false);
    assert.equal(isPrivatePageHostname("fdic.gov"), false);
    assert.equal(isPrivatePageHostname("fda.gov"), false);
    assert.equal(isPrivatePageHostname("fcbarcelona.com"), false);
    assert.equal(normalizePageUrl("https://fdic.gov/").hostname, "fdic.gov");
  });

  it("treats IPv6 ULA and link-local addresses as private", () => {
    assert.equal(isPrivatePageHostname("fc00::1"), true);
    assert.equal(isPrivatePageHostname("fd12:3456::1"), true);
    assert.equal(isPrivatePageHostname("fe80::1"), true);
    assert.equal(isPrivatePageHostname("::1"), true);
  });

  it("rejects IPv4-mapped IPv6 private addresses", () => {
    assert.equal(isPrivatePageHostname("::ffff:127.0.0.1"), true);
    assert.equal(isPrivatePageHostname("::ffff:10.0.0.1"), true);
    assert.equal(isPrivatePageHostname("::ffff:7f00:1"), true);
    assert.equal(isPrivatePageHostname("[::ffff:192.168.0.1]"), true);
    assert.throws(() => normalizePageUrl("http://[::ffff:127.0.0.1]/"), /Private/);
    assert.throws(() => normalizePageUrl("http://[::ffff:7f00:1]/"), /Private/);
    assert.equal(isPrivatePageHostname("::ffff:8.8.8.8"), false);
  });

  it("normalizes public page URLs and rejects private ones", () => {
    assert.equal(normalizePageUrl("example.com/page").href, "https://example.com/page");
    assert.throws(() => normalizePageUrl("http://127.0.0.1/"), /Private/);
    assert.throws(() => normalizePageUrl("https://user:pass@example.com/"), /usernames/);
  });

  it("extracts Cloudinary image delivery URLs from mixed content", () => {
    const content = `
      See https://res.cloudinary.com/demo/image/upload/w_360,dpr_2.0/v1/hero.jpg)
      and //res.cloudinary.com/demo/image/upload/f_auto/q_auto/v1/card.png
      ignore https://res.cloudinary.com/demo/video/upload/v1/clip.mp4
    `;
    const urls = extractCloudinaryImageUrls(content);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("/image/upload/"));
    assert.ok(!urls.some((url) => url.includes("/video/upload/")));
  });

  it("strips markdown link delimiters from URL candidates", () => {
    assert.equal(
      stripMarkdownUrlDelimiter("https://res.cloudinary.com/demo/image/upload/v1/a.jpg"),
      "https://res.cloudinary.com/demo/image/upload/v1/a.jpg"
    );
  });

  it("orders candidates by optimization potential and page order", () => {
    const candidates = [
      { foundOrder: 0, recommendation: { score: 40 } },
      { foundOrder: 1, recommendation: { score: 90 } },
      { foundOrder: 2, recommendation: { score: 90 } }
    ];
    assert.deepEqual(
      orderDomainScanCandidates(candidates, "potential-desc").map((item) => item.foundOrder),
      [1, 2, 0]
    );
    assert.deepEqual(
      orderDomainScanCandidates(candidates, "page-asc").map((item) => item.foundOrder),
      [0, 1, 2]
    );
  });

  it("detects Cloudinary helper references without DOMParser", () => {
    const detected = detectCloudinaryClientSideHelper('<script src="/vendor/cloudinary-core.js"></script>');
    assert.equal(detected.status, "detected");
    const missing = detectCloudinaryClientSideHelper("<html><body>no helpers</body></html>");
    assert.equal(missing.status, "missing");
    const unknown = detectCloudinaryClientSideHelper("", { unavailableReason: "HTML pass failed" });
    assert.equal(unknown.status, "unknown");
    assert.match(unknown.evidence, /HTML pass failed/);
  });
});

describe("deep links", () => {
  it("parses and builds asset/scan query strings", () => {
    const parsed = parseLabQuery("?asset=https%3A%2F%2Fexample.com%2Fa.jpg&scan=https%3A%2F%2Fexample.com%2Fpage");
    assert.equal(parsed.asset, "https://example.com/a.jpg");
    assert.equal(parsed.scan, "https://example.com/page");
    assert.equal(
      buildLabQuery({ asset: "https://example.com/a.jpg", scan: "https://example.com/page" }),
      "?asset=https%3A%2F%2Fexample.com%2Fa.jpg&scan=https%3A%2F%2Fexample.com%2Fpage"
    );
    assert.equal(buildLabQuery({}), "");
  });

  it("decodes URI components without throwing on malformed escapes", () => {
    assert.equal(safeDecodeURIComponent("SpacEx%20photo.jpg"), "SpacEx photo.jpg");
    assert.equal(safeDecodeURIComponent("bad%GGname.jpg"), "bad%GGname.jpg");
    assert.equal(safeDecodeURIComponent("trailing%"), "trailing%");
  });
});

describe("fluid URL helpers", () => {
  it("rounds fluid widths and builds markup", () => {
    assert.equal(roundFluidWidth(41), 80);
    assert.match(buildFluidMarkup("https://example.com/x.jpg", 320), /sizes="\(max-width: 320px\) 100vw, 320px"/);
  });

  it("resolves w_auto and dpr_auto into diagnostic URLs", () => {
    const fluid = sample("ar_3:2,c_fill/c_limit,w_auto:40:360,dpr_auto/f_auto/q_auto");
    const resolved = buildResolvedFluidPreviewUrl(fluid, 400, 2);
    assert.match(resolved, /w_400/);
    assert.match(resolved, /dpr_2\.0/);
    const automatic = buildFluidAutomaticUrl(fluid, 480);
    assert.match(automatic, /w_auto:40:480/);
  });
});

describe("browser helpers", () => {
  it("detects Chromium-family user agents", () => {
    assert.equal(isChromiumBrowser("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"), true);
    assert.equal(isChromiumBrowser("Mozilla/5.0 Firefox/120.0"), false);
  });
});

describe("audit edge cases", () => {
  it("warns on signed URLs", () => {
    const parsed = parseCloudinaryUrl(
      "https://res.cloudinary.com/demo/image/upload/s--abc123--/w_360,dpr_2.0/v1/sample.jpg"
    );
    const audit = buildAudit(parsed);
    assert.ok(audit.issues.some((issue) => /signed/i.test(issue.title) || /signature/i.test(issue.title) || /signed/i.test(issue.text)));
  });

  it("flags bare w_auto without a fallback", () => {
    const parsed = parseCloudinaryUrl(sample("w_auto,dpr_auto/f_auto/q_auto"));
    const audit = buildAudit(parsed);
    assert.ok(audit.issues.some((issue) => /w_auto/i.test(issue.title) || /fallback/i.test(issue.title) || /fallback/i.test(issue.text)));
  });

  it("surfaces custom delivery origin guidance from scan context", () => {
    const parsed = parseCloudinaryUrl(
      "https://media.example.com/image/upload/w_360,dpr_auto/f_auto/q_auto/v1/sample.jpg"
    );
    const audit = buildAudit(parsed, {
      fromScan: true,
      sourcePageUrl: "https://example.com/",
      clientSideHelper: { status: "missing", evidence: "missing" }
    });
    assert.ok(audit.issues.some((issue) => /origin|client hint|delegate/i.test(`${issue.title} ${issue.text}`)));
  });
});
