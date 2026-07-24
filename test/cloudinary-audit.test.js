import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCloudinaryUrl,
  buildAudit,
  buildDeliveryUrl,
  normalizeOptimizationOrder,
  getScannedUrlRecommendation,
  buildAutomaticDprSimulation,
  getRoundedDeviceDpr,
  buildScrapedLayoutContext
} from "../lib/cloudinary-audit.js";

const sample = (transforms, publicId = "sample.jpg") =>
  `https://res.cloudinary.com/demo/image/upload/${transforms}/v1/${publicId}`;

describe("parseCloudinaryUrl", () => {
  it("splits versioned transforms from the public id", () => {
    const parsed = parseCloudinaryUrl(sample("c_fill,w_360,h_240,dpr_2.0/f_auto/q_auto"));
    assert.equal(parsed.resourceType, "image");
    assert.deepEqual(parsed.transformationSegments, ["c_fill,w_360,h_240,dpr_2.0", "f_auto", "q_auto"]);
    assert.deepEqual(parsed.assetSegments, ["v1", "sample.jpg"]);
    assert.ok(parsed.tokens.includes("dpr_2.0"));
  });

  it("rejects non-delivery URLs", () => {
    assert.throws(() => parseCloudinaryUrl("https://example.com/photo.jpg"), /Cloudinary/);
  });

  it("rejects video upload URLs", () => {
    assert.throws(
      () => parseCloudinaryUrl("https://res.cloudinary.com/demo/video/upload/v1/clip.mp4"),
      /image\/upload/
    );
  });

  it("parses unsigned paths without a version segment", () => {
    const parsed = parseCloudinaryUrl(
      "https://res.cloudinary.com/demo/image/upload/w_360,dpr_auto/f_auto/q_auto/folder/hero.jpg"
    );
    assert.deepEqual(parsed.transformationSegments, ["w_360,dpr_auto", "f_auto", "q_auto"]);
    assert.deepEqual(parsed.assetSegments, ["folder", "hero.jpg"]);
  });
});

describe("buildAudit", () => {
  it("flags missing f_auto/q_auto and offers dpr_auto for fixed DPR", () => {
    const parsed = parseCloudinaryUrl(sample("c_fill,w_360,h_240,dpr_2.0"));
    const audit = buildAudit(parsed);
    assert.equal(audit.dpr.isExplicit, true);
    assert.equal(audit.dpr.value, 2);
    assert.match(audit.correctedUrl, /\/f_auto\/q_auto(?:\?|$|\/v1)/);
    assert.match(audit.responsiveUrl, /dpr_auto/);
    assert.ok(audit.issues.some((issue) => issue.title === "Automatic optimization is incomplete"));
    assert.ok(audit.issues.some((issue) => issue.severity === "warning" && /HTML dimensions/i.test(issue.title)));
  });

  it("errors when DPR has no resize dimension", () => {
    const parsed = parseCloudinaryUrl(sample("dpr_2.0/f_auto/q_auto"));
    const audit = buildAudit(parsed);
    assert.ok(audit.issues.some((issue) => issue.title === "DPR has no resize dimension"));
  });

  it("errors on unsupported h_auto", () => {
    const parsed = parseCloudinaryUrl(sample("w_360,h_auto,dpr_auto/f_auto/q_auto"));
    const audit = buildAudit(parsed);
    assert.ok(audit.issues.some((issue) => issue.title === "h_auto is not a supported delivery transformation"));
  });

  it("detects possible double DPR from filename dimensions", () => {
    const parsed = parseCloudinaryUrl(sample("w_720,dpr_2.0/f_auto/q_auto", "hero_360x240.jpg"));
    const audit = buildAudit(parsed);
    const doubleDpr = audit.issues.find((issue) => issue.title === "Possible double DPR calculation");
    assert.ok(doubleDpr);
    assert.match(doubleDpr.suggestion, /w_360/);
  });

  it("reports client-side helper status from scan context", () => {
    const parsed = parseCloudinaryUrl(sample("w_360,dpr_auto/f_auto/q_auto"));
    const audit = buildAudit(parsed, {
      fromScan: true,
      sourcePageUrl: "https://example.com/",
      clientSideHelper: {
        status: "missing",
        evidence: "No known Cloudinary client-side helper script or initialization call was detected in the scraped page HTML."
      }
    });
    assert.ok(audit.issues.some((issue) => issue.title === "Client-side helper: missing"));
  });

  it("keeps optimization components at the end", () => {
    const segments = normalizeOptimizationOrder(["f_auto,w_360", "q_auto,dpr_2.0", "c_fill"]);
    assert.deepEqual(segments, ["w_360", "dpr_2.0", "c_fill", "f_auto", "q_auto"]);
    const parsed = parseCloudinaryUrl(sample("f_auto,w_360/q_auto,dpr_2.0"));
    const audit = buildAudit(parsed);
    assert.ok(audit.issues.some((issue) => issue.title === "Optimization transformations are in the wrong position"));
  });
});

describe("getScannedUrlRecommendation", () => {
  it("returns null when the URL has no DPR transform", () => {
    assert.equal(getScannedUrlRecommendation(sample("w_360/f_auto/q_auto")), null);
  });

  it("scores fixed DPR URLs with optimization opportunities", () => {
    const recommendation = getScannedUrlRecommendation(
      sample("c_fill,w_360,h_240,dpr_2.0/f_auto/q_auto"),
      null,
      { devicePixelRatio: 2 }
    );
    assert.ok(recommendation);
    assert.ok(recommendation.score >= 30);
    assert.equal(recommendation.dprLabel, "2× fixed");
    assert.ok(recommendation.automaticSimulation);
    assert.equal(recommendation.automaticSimulation.targetDpr, 2);
  });
});

describe("buildAutomaticDprSimulation", () => {
  it("resolves dpr_auto to an explicit diagnostic DPR", () => {
    const parsed = parseCloudinaryUrl(sample("w_360,h_240,dpr_2.0/f_auto/q_auto"));
    const audit = buildAudit(parsed);
    const simulation = buildAutomaticDprSimulation(parsed, audit, null, { devicePixelRatio: 2.5 });
    assert.equal(simulation.targetDpr, 3);
    assert.match(simulation.url, /dpr_3\.0/);
    assert.match(simulation.productionUrl, /dpr_auto/);
    assert.equal(simulation.logicalWidth, 360);
  });
});

describe("buildScrapedLayoutContext", () => {
  it("prefers HTML width/height attributes over URL transforms", () => {
    const layout = buildScrapedLayoutContext(
      sample("w_800,h_600,dpr_2.0/f_auto/q_auto"),
      { widthAttribute: "400", heightAttribute: "300", pageIndex: 0 }
    );
    assert.equal(layout.displayWidth, 400);
    assert.equal(layout.displayHeight, 300);
    assert.equal(layout.confidence, "declared");
    assert.match(layout.source, /HTML width\/height/);
  });
});

describe("helpers", () => {
  it("rounds device pixel ratio up to a whole DPR", () => {
    assert.equal(getRoundedDeviceDpr(1), 1);
    assert.equal(getRoundedDeviceDpr(1.25), 2);
    assert.equal(getRoundedDeviceDpr(2.01), 3);
  });

  it("rebuilds delivery URLs from parsed parts", () => {
    const parsed = parseCloudinaryUrl(sample("w_360/f_auto/q_auto"));
    const url = buildDeliveryUrl(parsed, ["w_180", "f_auto", "q_auto"]);
    assert.equal(
      url,
      "https://res.cloudinary.com/demo/image/upload/w_180/f_auto/q_auto/v1/sample.jpg"
    );
  });
});
