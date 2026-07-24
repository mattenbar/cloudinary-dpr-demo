import {
  formatDimensions,
  getRoundedDeviceDpr,
  getClientHintSetup,
  parseCloudinaryUrl,
  replaceTransformationToken,
  buildDeliveryUrl,
  buildScrapedLayoutContext,
  orderAuditIssues,
  buildAudit,
  buildAutomaticDprSimulation,
  getScannedUrlRecommendation
} from "./lib/cloudinary-audit.js";

const BASE_WIDTH = 360;
const BASE_HEIGHT = 240;
const FLUID_PREVIEW_MAX_WIDTH = 720;
const DEFAULT_ASSET_URL = "https://res.cloudinary.com/doxfstysv/image/upload/v1783615661/SpacEx_Getty-1360560315_m8u9dx.jpg";
const DOMAIN_READER_ORIGIN = "https://r.jina.ai/";
const DOMAIN_SCAN_DEFAULT_LIMIT = 5;
const RECEIPT_LABELS = {
  original: "Original source",
  baseline: "Fixed 1×",
  fixed: "Hard-coded 2×",
  auto: "Automatic DPR",
  autoExpected: "Expected automatic output",
  fluid: "Fluid automatic width + DPR"
};
const RECEIPT_SETTINGS = {
  original: "No transformations",
  baseline: "DPR omitted",
  fixed: "dpr_2.0",
  auto: "dpr_auto",
  autoExpected: "Resolved device DPR diagnostic",
  fluid: "w_auto + dpr_auto"
};
const metrics = new Map();
const receiptUrls = {};
let measurementRun = 0;
let domainScanController = null;
let domainScanRun = 0;
let domainScanCandidates = [];
let domainScanPageUrl = null;
let domainScanPage = 1;
let lastReceiptTrigger = null;
let activeScanAnalysisContext = null;
let activeReceiptKey = null;
let activeExpectedSimulation = null;
let activeAssetParsed = null;
let activeRuleContext = null;
let expectedDprTarget = 0;
let fluidPreviewWidth = BASE_WIDTH;
let fluidResizeStart = null;

const buildFluidMarkup = (url, width = BASE_WIDTH) => {
  const cssWidth = Math.max(1, Math.round(width));
  const cssHeight = Math.round(cssWidth * BASE_HEIGHT / BASE_WIDTH);
  return `<img src="${url}" sizes="(max-width: ${cssWidth}px) 100vw, ${cssWidth}px" width="${cssWidth}" height="${cssHeight}" style="width:100%;max-width:${cssWidth}px;height:auto" alt="">`;
};

const buildExpectedMarkup = (simulation, url) => {
  const measurement = metrics.get("autoExpected");
  const width = simulation?.logicalWidth || Math.round(measurement?.renderedWidth || BASE_WIDTH);
  const height = simulation?.logicalHeight || Math.round(measurement?.renderedHeight || BASE_HEIGHT);
  const fluid = simulation?.layoutContext?.fluid;
  const sizes = simulation?.layoutContext?.sizes
    || simulation?.layoutContext?.suggestedSizes
    || (fluid ? `(max-width: ${width}px) 100vw, ${width}px` : "");
  return `<img src="${url}"${sizes ? ` sizes="${sizes}"` : ""} width="${width}" height="${height}"${fluid ? ` style="width:100%;max-width:${width}px;height:auto"` : ""} alt="">`;
};

const roundFluidWidth = (width) => Math.max(40, Math.ceil(width / 40) * 40);

const buildResolvedFluidPreviewUrl = (url, width, dpr) => {
  const parsed = parseCloudinaryUrl(url);
  let segments = replaceTransformationToken(parsed.transformationSegments, /^w_auto(?:$|:)/, `w_${width}`);
  segments = replaceTransformationToken(segments, /^dpr_auto$/, `dpr_${dpr.toFixed(1)}`);
  return buildDeliveryUrl(parsed, segments);
};

const buildFluidAutomaticUrl = (url, fallbackWidth) => {
  const parsed = parseCloudinaryUrl(url);
  const segments = replaceTransformationToken(
    parsed.transformationSegments,
    /^w_auto(?:$|:)/,
    `w_auto:40:${fallbackWidth}`
  );
  return buildDeliveryUrl(parsed, segments);
};

const getFluidPreviewMaxWidth = () => {
  const preview = document.querySelector(".receipt-dialog-preview");
  const controls = document.querySelector("#receipt-fluid-controls");
  const styles = getComputedStyle(preview);
  const isColumn = styles.flexDirection.startsWith("column");
  const gap = Number.parseFloat(isColumn ? styles.rowGap : styles.columnGap)
    || Number.parseFloat(styles.gap)
    || 0;
  const innerWidth = preview.clientWidth
    - (Number.parseFloat(styles.paddingLeft) || 0)
    - (Number.parseFloat(styles.paddingRight) || 0);
  const innerHeight = preview.clientHeight
    - (Number.parseFloat(styles.paddingTop) || 0)
    - (Number.parseFloat(styles.paddingBottom) || 0);
  const availableWidth = innerWidth - (isColumn ? 18 : controls.offsetWidth + gap + 18);
  const availableHeight = innerHeight - (isColumn ? controls.offsetHeight + gap : 0);
  const heightLimitedWidth = availableHeight * BASE_WIDTH / BASE_HEIGHT;
  return Math.max(120, Math.min(
    FLUID_PREVIEW_MAX_WIDTH,
    Math.floor(availableWidth),
    Math.floor(heightLimitedWidth)
  ));
};

const updateFluidActualOutput = () => {
  if (activeReceiptKey !== "fluid") return;
  const image = document.querySelector("#receipt-dialog-image");
  if (!image.naturalWidth) {
    document.querySelector("#receipt-fluid-actual-output").textContent = "Could not load preview";
    document.querySelector("#receipt-fluid-file-size").textContent = "Unavailable";
    document.querySelector("#receipt-fluid-bandwidth").textContent = "Unavailable";
    return;
  }
  const resource = getResourceDetails(image.currentSrc || image.src);
  const width = resource.width || image.naturalWidth;
  const height = resource.height || image.naturalHeight;
  const displayedHeight = fluidPreviewWidth * BASE_HEIGHT / BASE_WIDTH;
  const effectiveDpr = fluidPreviewWidth ? width / fluidPreviewWidth : 0;
  document.querySelector("#receipt-fluid-actual-output").textContent = formatDimensions(width, height);
  document.querySelector("#receipt-fluid-file-size").textContent = formatBytes(resource.bytes);
  document.querySelector("#receipt-fluid-bandwidth").textContent = formatBandwidth(resource);
  document.querySelector("#receipt-detail-delivered").textContent = formatDimensions(width, height);
  document.querySelector("#receipt-detail-displayed").textContent = formatDimensions(fluidPreviewWidth, displayedHeight);
  document.querySelector("#receipt-detail-dpr").textContent = effectiveDpr ? `${effectiveDpr.toFixed(1)}×` : "Unavailable";
  document.querySelector("#receipt-detail-file-size").textContent = formatBytes(resource.bytes);
  document.querySelector("#receipt-detail-bandwidth").textContent = formatBandwidth(resource);
  document.querySelector("#receipt-detail-delta").textContent = formatDelta(resource.bytes, metrics.get("original")?.bytes || 0);
};

const updateFluidPreview = (requestedWidth = fluidPreviewWidth) => {
  if (activeReceiptKey !== "fluid" || !receiptUrls.fluid) return;
  const frame = document.querySelector("#receipt-preview-frame");
  const range = document.querySelector("#receipt-fluid-width-range");
  const maxWidth = getFluidPreviewMaxWidth();
  const cssWidth = Math.round(Math.min(maxWidth, Math.max(120, requestedWidth)));
  const automaticWidth = roundFluidWidth(cssWidth);
  const deviceDpr = window.devicePixelRatio || 1;
  const automaticDpr = getRoundedDeviceDpr();
  const physicalWidth = automaticWidth * automaticDpr;
  const physicalHeight = Math.round(physicalWidth * BASE_HEIGHT / BASE_WIDTH);
  const resolvedUrl = buildResolvedFluidPreviewUrl(receiptUrls.fluid, automaticWidth, automaticDpr);
  const automaticUrl = buildFluidAutomaticUrl(receiptUrls.fluid, automaticWidth);
  const automaticMarkup = buildFluidMarkup(automaticUrl, cssWidth);

  fluidPreviewWidth = cssWidth;
  frame.style.width = `${cssWidth}px`;
  range.max = String(maxWidth);
  range.value = String(cssWidth);
  document.querySelector("#receipt-fluid-width-output").textContent = `${cssWidth} px`;
  document.querySelector("#receipt-fluid-css-width").textContent = `${cssWidth} px`;
  document.querySelector("#receipt-fluid-auto-width").textContent = `${automaticWidth} px`;
  document.querySelector("#receipt-fluid-auto-dpr").textContent = `${automaticDpr}× (device ${deviceDpr.toFixed(2)}×)`;
  document.querySelector("#receipt-fluid-target-pixels").textContent = formatDimensions(physicalWidth, physicalHeight);
  document.querySelector("#receipt-fluid-resolved-url").textContent = resolvedUrl;
  document.querySelector("#receipt-fluid-resolved-link").href = resolvedUrl;
  document.querySelector("#receipt-optimal-url").textContent = automaticUrl;
  document.querySelector("#receipt-optimal-link").href = automaticUrl;
  document.querySelector("#receipt-required-markup").textContent = automaticMarkup;
  document.querySelector("#receipt-fluid-dialog-url").textContent = automaticUrl;
  document.querySelector("#receipt-fluid-dialog-link").href = automaticUrl;
  document.querySelector("#receipt-fluid-dialog-markup").textContent = automaticMarkup;

  const image = document.querySelector("#receipt-dialog-image");
  if (image.dataset.previewUrl !== resolvedUrl) {
    image.dataset.previewUrl = resolvedUrl;
    document.querySelector("#receipt-fluid-actual-output").textContent = "Loading…";
    document.querySelector("#receipt-fluid-file-size").textContent = "Loading…";
    document.querySelector("#receipt-fluid-bandwidth").textContent = "Loading…";
    image.src = resolvedUrl;
  } else {
    updateFluidActualOutput();
  }
};

const imageReady = (image) => {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  });
};

const getResourceDetails = (url) => {
  const entries = performance.getEntriesByName(url);
  const encodedBodySizes = entries.map((entry) => entry.encodedBodySize).filter((value) => value > 0);
  const transferSizes = entries.map((entry) => entry.transferSize).filter((value) => value > 0);
  const contentInfo = entries
    .flatMap((entry) => [...(entry.serverTiming || [])])
    .filter((timing) => timing.name === "content-info" && timing.description)
    .at(-1);
  const description = contentInfo?.description || "";
  const width = Number(description.match(/(?:^|,)width=(\d+)/)?.[1]) || 0;
  const height = Number(description.match(/(?:^|,)height=(\d+)/)?.[1]) || 0;
  const responseBytes = Number(description.match(/(?:^|,)bytes=(\d+)/)?.[1]) || 0;
  const bytes = encodedBodySizes.length ? Math.max(...encodedBodySizes) : responseBytes;
  const transferBytes = transferSizes.length ? Math.max(...transferSizes) : 0;

  return {
    bytes,
    transferBytes,
    wasCached: entries.length > 0 && transferBytes === 0 && bytes > 0,
    width,
    height
  };
};

const setMetricText = (key, value, text) => {
  document.querySelectorAll(`[data-for="${key}"][data-value="${value}"]`).forEach((element) => {
    element.textContent = text;
  });
};

const measureImage = (image) => {
  const key = image.dataset.metric;
  const bounds = image.getBoundingClientRect();
  const resource = getResourceDetails(image.currentSrc || image.src);
  const deliveredWidth = resource.width || image.naturalWidth;
  const deliveredHeight = resource.height || image.naturalHeight;
  let renderedWidth = bounds.width;
  let renderedHeight = bounds.height;
  if (activeRuleContext && key === "wrong") {
    renderedWidth = deliveredWidth;
    renderedHeight = deliveredHeight;
  } else if (activeRuleContext && key === "correct") {
    renderedWidth = activeRuleContext.displayWidth;
    renderedHeight = activeRuleContext.displayHeight;
  }
  const effectiveDensity = renderedWidth ? deliveredWidth / renderedWidth : 0;
  const bytes = resource.bytes;
  const measurement = {
    natural: formatDimensions(deliveredWidth, deliveredHeight),
    rendered: formatDimensions(renderedWidth, renderedHeight),
    effective: effectiveDensity ? `${effectiveDensity.toFixed(1)}×` : "—",
    bytes,
    transferBytes: resource.transferBytes,
    wasCached: resource.wasCached,
    naturalWidth: deliveredWidth,
    naturalHeight: deliveredHeight,
    renderedWidth,
    renderedHeight,
    effectiveDensity
  };

  metrics.set(key, measurement);
  setMetricText(key, "natural", measurement.natural);
  setMetricText(key, "rendered", measurement.rendered);
  setMetricText(key, "effective", measurement.effective);
  setMetricText(key, "bytes", formatBytes(bytes));
  return measurement;
};

const updateResultTable = () => {
  const originalBytes = metrics.get("original")?.bytes || 0;

  ["original", "baseline", "fixed", "auto", "autoExpected", "fluid"].forEach((key) => {
    const measurement = metrics.get(key);
    const row = document.querySelector(`[data-result-row="${key}"]`);
    if (!measurement || !row) return;

    row.querySelector('[data-result="natural"]').textContent = measurement.natural;
    row.querySelector('[data-result="rendered"]').textContent = key === "original" ? "—" : measurement.rendered;
    row.querySelector('[data-result="bytes"]').textContent = formatBytes(measurement.bytes);
    row.querySelector('[data-result="bandwidth"]').textContent = formatBandwidth(measurement);
    row.querySelector('[data-result="delta"]').textContent = formatDelta(measurement.bytes, originalBytes, key === "original");
  });
};

const updateEfficiencyVerdict = () => {
  const bandwidthVerdict = document.querySelector("#bandwidth-verdict");
  const recommendationVerdict = document.querySelector("#recommendation-verdict");
  const targetDpr = getRoundedDeviceDpr();
  const receiptKeys = ["original", "baseline", "fixed", "auto"];
  const strategyKeys = ["baseline", "fixed", "auto"];
  receiptKeys.forEach((key) => {
    const row = document.querySelector(`[data-result-row="${key}"]`);
    row?.classList.remove("is-smallest-transfer", "is-device-recommended", "needs-client-hint-setup");
    const bandwidthBadge = document.querySelector(`[data-bandwidth-badge="${key}"]`);
    const recommendationBadge = document.querySelector(`[data-recommendation-badge="${key}"]`);
    const setupBadge = document.querySelector(`[data-setup-badge="${key}"]`);
    if (bandwidthBadge) bandwidthBadge.hidden = true;
    if (recommendationBadge) {
      recommendationBadge.hidden = true;
      recommendationBadge.textContent = "Recommended for device";
    }
    if (setupBadge) {
      setupBadge.hidden = true;
      setupBadge.textContent = "Live dpr_auto needs setup";
    }
  });

  const measuredReceipts = receiptKeys.map((key) => ({ key, measurement: metrics.get(key) }));
  const hasCompleteNetworkTransfers = measuredReceipts.every((candidate) => candidate.measurement?.transferBytes > 0);
  const bandwidthAvailable = measuredReceipts
    .map(({ key, measurement }) => {
      const comparisonBytes = hasCompleteNetworkTransfers ? measurement?.transferBytes : measurement?.bytes;
      return comparisonBytes > 0 ? { key, measurement, comparisonBytes } : null;
    })
    .filter(Boolean);

  if (bandwidthAvailable.length) {
    const smallestBytes = Math.min(...bandwidthAvailable.map((candidate) => candidate.comparisonBytes));
    const smallestTransfers = bandwidthAvailable.filter((candidate) => candidate.comparisonBytes === smallestBytes);
    smallestTransfers.forEach((candidate) => {
      document.querySelector(`[data-result-row="${candidate.key}"]`)?.classList.add("is-smallest-transfer");
      const badge = document.querySelector(`[data-bandwidth-badge="${candidate.key}"]`);
      if (badge) badge.hidden = false;
    });
    const labels = smallestTransfers.map((candidate) => RECEIPT_LABELS[candidate.key]).join(" / ");
    const basis = hasCompleteNetworkTransfers
      ? "This is the lowest measured network transfer, including response overhead and regardless of DPR suitability."
      : "Some network transfers were cached or unavailable, so this comparison uses encoded file size instead.";
    bandwidthVerdict.innerHTML = `<strong>Smallest transfer: ${labels}</strong> — ${formatBytes(smallestBytes)}. ${basis}`;
  } else {
    bandwidthVerdict.innerHTML = "<strong>Smallest transfer:</strong> Byte totals are unavailable in this browser session.";
  }

  const recommendationAvailable = strategyKeys
    .map((key) => {
      const measurement = metrics.get(key);
      return measurement?.bytes > 0
        ? { key, measurement, deliveredDpr: measurement.naturalWidth / BASE_WIDTH }
        : null;
    })
    .filter(Boolean);

  if (!recommendationAvailable.length) {
    const fallbackRow = document.querySelector('[data-result-row="auto"]');
    const fallbackBadge = document.querySelector('[data-recommendation-badge="auto"]');
    fallbackRow?.classList.add("is-device-recommended");
    if (fallbackBadge) fallbackBadge.hidden = false;
    recommendationVerdict.innerHTML = "<strong>Recommended for this device: Automatic DPR</strong> — the adaptive option is preferred, but byte totals are unavailable in this browser session.";
    return;
  }

  const qualified = recommendationAvailable.filter((candidate) => candidate.deliveredDpr + .05 >= targetDpr);
  const pool = qualified.length ? qualified : recommendationAvailable;
  pool.sort((first, second) => {
    if (!qualified.length && Math.abs(first.deliveredDpr - second.deliveredDpr) > .05) {
      return second.deliveredDpr - first.deliveredDpr;
    }
    if (first.measurement.bytes !== second.measurement.bytes) {
      return first.measurement.bytes - second.measurement.bytes;
    }
    return first.key === "auto" ? -1 : second.key === "auto" ? 1 : 0;
  });

  const selected = pool[0];
  const autoMeasurement = metrics.get("auto");
  const autoDeliveredDpr = autoMeasurement?.naturalWidth ? autoMeasurement.naturalWidth / BASE_WIDTH : 0;
  const automaticMissedTarget = targetDpr > 1 && autoDeliveredDpr > 0 && autoDeliveredDpr + .05 < targetDpr;
  document.querySelector(`[data-result-row="${selected.key}"]`)?.classList.add("is-device-recommended");
  const badge = document.querySelector(`[data-recommendation-badge="${selected.key}"]`);
  if (badge) {
    badge.hidden = false;
    if (automaticMissedTarget) badge.textContent = "Best measured fallback";
  }

  if (automaticMissedTarget) {
    document.querySelector('[data-result-row="auto"]')?.classList.add("needs-client-hint-setup");
    const setupBadge = document.querySelector('[data-setup-badge="auto"]');
    if (setupBadge) {
      const isChromium = /Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(navigator.userAgent) && !/Firefox|FxiOS/.test(navigator.userAgent);
      setupBadge.hidden = false;
      setupBadge.textContent = window.location.protocol === "file:"
        ? "Live preview requires HTTPS"
        : isChromium ? "Live dpr_auto needs setup" : "Live preview needs Chromium";
    }
  }

  if (automaticMissedTarget) {
    let deliveryOrigin = "the image delivery origin";
    try { deliveryOrigin = new URL(receiptUrls.auto).origin; } catch { /* Keep the readable fallback. */ }
    const customScrapedOrigin = activeScanAnalysisContext?.fromScan && deliveryOrigin !== "https://res.cloudinary.com";
    const isChromium = /Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(navigator.userAgent) && !/Firefox|FxiOS/.test(navigator.userAgent);
    const cause = window.location.protocol === "file:"
      ? "A file:// page cannot delegate the DPR client hint."
      : !isChromium
        ? "Automatic server-side DPR client hints currently require a supported Chromium browser."
        : customScrapedOrigin
        ? `This scraped custom origin was discovered after the lab loaded, so the lab cannot retroactively delegate Sec-CH-DPR to ${deliveryOrigin}.`
        : `Verify that this HTTPS page delegates Sec-CH-DPR to ${deliveryOrigin} in a supported Chromium browser.`;
    const expectedMeasurement = metrics.get("autoExpected");
    const expectedResult = expectedMeasurement?.naturalWidth
      ? ` The page-layout-based “Expected with setup” preview resolves the target deterministically and delivered ${expectedMeasurement.natural}, ${formatBytes(expectedMeasurement.bytes)} file size, and ${formatBandwidth(expectedMeasurement)} bandwidth.`
      : " The page-layout-based expected preview is unavailable because reliable sizing metadata could not be resolved.";
    recommendationVerdict.innerHTML = `<strong>Best live 360 × 240 benchmark fallback: ${RECEIPT_LABELS[selected.key]}</strong> — ${formatBytes(selected.measurement.bytes)} file, ${formatBandwidth(selected.measurement)} bandwidth at ${selected.deliveredDpr.toFixed(1)}× delivered DPR. Live dpr_auto delivered ${autoDeliveredDpr.toFixed(1)}× instead of the ${targetDpr}× target. ${cause}${expectedResult} The benchmark and scraped-page row use different layout sizes, so compare their bytes only within the displayed dimensions shown. Keep dpr_auto as the adaptive production strategy after client-hint setup is verified.`;
  } else {
    const reason = qualified.length
      ? `It is the smallest measured response that meets this browser’s rounded ${targetDpr}× DPR target.`
      : `No measured strategy reached this browser’s rounded ${targetDpr}× DPR target, so this is the highest-density measured option with the fewest bytes.`;
    recommendationVerdict.innerHTML = `<strong>Recommended for this device: ${RECEIPT_LABELS[selected.key]}</strong> — ${formatBytes(selected.measurement.bytes)} file, ${formatBandwidth(selected.measurement)} bandwidth at ${selected.deliveredDpr.toFixed(1)}× delivered DPR. ${reason}`;
  }
};

const openReceiptDialog = (key, trigger) => {
  const currentUrl = receiptUrls[key];
  const fluidUrl = receiptUrls.fluid;
  const isFluid = key === "fluid";
  const isExpected = key === "autoExpected";
  const optimalUrl = isFluid
    ? fluidUrl
    : isExpected ? activeExpectedSimulation?.productionUrl : receiptUrls.auto;
  if (!currentUrl || !optimalUrl) return;

  const dialog = document.querySelector("#receipt-dialog");
  const measurement = metrics.get(key);
  const originalBytes = metrics.get("original")?.bytes || 0;
  const row = document.querySelector(`[data-result-row="${key}"]`);
  const body = document.querySelector(".receipt-dialog-body");
  const frame = document.querySelector("#receipt-preview-frame");
  const controls = document.querySelector("#receipt-fluid-controls");
  const resizeHandle = document.querySelector("#receipt-fluid-resize-handle");
  const liveBlock = document.querySelector("#receipt-fluid-live-block");
  activeReceiptKey = key;
  dialog.classList.toggle("is-fluid-dialog", isFluid);
  body.classList.toggle("is-fluid-layout", isFluid);
  lastReceiptTrigger = trigger;
  document.querySelector("#receipt-dialog-title").textContent = `${RECEIPT_LABELS[key]} details`;
  const image = document.querySelector("#receipt-dialog-image");
  image.dataset.previewUrl = "";
  image.src = currentUrl;
  image.alt = `${RECEIPT_LABELS[key]} image preview`;
  frame.classList.toggle("is-fluid", isFluid);
  frame.classList.toggle("is-static", !isFluid);
  if (!isFluid) frame.style.removeProperty("width");
  controls.hidden = !isFluid;
  resizeHandle.hidden = !isFluid;
  liveBlock.hidden = !isFluid;
  document.querySelector("#receipt-detail-strategy").textContent = RECEIPT_LABELS[key];
  document.querySelector("#receipt-detail-setting").textContent = isExpected
    ? document.querySelector("#auto-expected-setting").textContent
    : RECEIPT_SETTINGS[key];
  document.querySelector("#receipt-detail-delivered").textContent = measurement?.natural || "Unavailable";
  document.querySelector("#receipt-detail-displayed").textContent = key === "original" ? "Not applicable" : measurement?.rendered || "Unavailable";
  document.querySelector("#receipt-detail-dpr").textContent = key === "original" ? "Not applicable" : measurement?.effective || "Unavailable";
  document.querySelector("#receipt-detail-file-size").textContent = formatBytes(measurement?.bytes);
  document.querySelector("#receipt-detail-bandwidth").textContent = formatBandwidth(measurement);
  document.querySelector("#receipt-detail-delta").textContent = formatDelta(measurement?.bytes, originalBytes, key === "original");

  const status = document.querySelector("#receipt-detail-status");
  status.replaceChildren();
  if (row?.classList.contains("is-smallest-transfer")) {
    const badge = document.createElement("span");
    badge.className = "efficiency-badge bandwidth-badge";
    badge.textContent = "Smallest transfer";
    status.append(badge);
  }
  if (row?.classList.contains("is-device-recommended")) {
    const badge = document.createElement("span");
    badge.className = "efficiency-badge recommendation-badge";
    badge.textContent = document.querySelector(`[data-recommendation-badge="${key}"]`)?.textContent || "Recommended for device";
    status.append(badge);
  }
  if (row?.classList.contains("needs-client-hint-setup")) {
    const badge = document.createElement("span");
    badge.className = "efficiency-badge setup-badge";
    badge.textContent = document.querySelector(`[data-setup-badge="${key}"]`)?.textContent || "Client-hint setup needed";
    status.append(badge);
  }
  if (isFluid) {
    const badge = document.createElement("span");
    badge.className = "efficiency-badge fluid-layout-badge";
    badge.textContent = "Fluid layout recommendation";
    status.append(badge);
  }
  if (isExpected) {
    const badge = document.createElement("span");
    badge.className = "efficiency-badge expected-output-badge";
    badge.textContent = `Expected with setup · ${activeExpectedSimulation?.targetDpr || getRoundedDeviceDpr()}×`;
    status.append(badge);
  }
  document.querySelector("#receipt-detail-bandwidth-verdict").innerHTML =
    document.querySelector("#bandwidth-verdict").innerHTML;
  document.querySelector("#receipt-detail-recommendation-verdict").innerHTML =
    document.querySelector("#recommendation-verdict").innerHTML;
  document.querySelector("#receipt-current-url").textContent = currentUrl;
  document.querySelector("#receipt-current-link").href = currentUrl;
  document.querySelector("#receipt-optimal-url").textContent = optimalUrl;
  document.querySelector("#receipt-optimal-link").href = optimalUrl;
  document.querySelector("#receipt-current-heading").textContent = isExpected ? "Deterministic preview URL" : "Current URL";
  document.querySelector("#receipt-optimal-heading").textContent = isExpected ? "Production dpr_auto URL" : "Optimal URL";
  document.querySelector("#receipt-current-link").textContent = isExpected ? "Open preview ↗" : "Open current ↗";
  document.querySelector("#receipt-optimal-link").textContent = isExpected ? "Open production ↗" : "Open optimal ↗";
  document.querySelector("#receipt-required-markup").textContent = isFluid
    ? buildFluidMarkup(optimalUrl)
    : isExpected
      ? buildExpectedMarkup(activeExpectedSimulation, optimalUrl)
      : `<img src="${optimalUrl}" width="${BASE_WIDTH}" height="${BASE_HEIGHT}" alt="">`;
  const clientHintBlock = document.querySelector("#receipt-client-hint-block");
  const showClientHintSetup = key === "auto" || isExpected || isFluid;
  clientHintBlock.hidden = !showClientHintSetup;
  if (showClientHintSetup) {
    const setup = getClientHintSetup(new URL(optimalUrl).origin);
    document.querySelector("#receipt-client-hint-meta").textContent = setup.meta;
    document.querySelector("#receipt-client-hint-headers").textContent = setup.headers;
  }
  document.querySelector("#receipt-fluid-dialog-url").textContent = fluidUrl || "Unavailable";
  document.querySelector("#receipt-fluid-dialog-markup").textContent = fluidUrl ? buildFluidMarkup(fluidUrl) : "Unavailable";
  document.querySelector("#receipt-fluid-dialog-link").href = fluidUrl || "#";
  document.querySelector("#receipt-dialog-note").innerHTML = isExpected
    ? `<strong>Expected after setup:</strong> This preview resolves <code>dpr_auto</code> to ${activeExpectedSimulation?.targetDpr || getRoundedDeviceDpr()}× and uses ${activeExpectedSimulation?.sizingBasis || "the analyzed layout"}. It bypasses client hints only for diagnosis. Use the production URL and markup above after enabling DPR delegation.`
    : isFluid
      ? "<strong>Live fluid recommendation:</strong> Resize the slot above to update the production <code>w_auto</code> fallback, matching <code>sizes</code> rule, dimensions, file size, and bandwidth. The explicit preview URL is diagnostic; keep <code>w_auto</code> and <code>dpr_auto</code> in production."
      : "<strong>Choose by layout:</strong> The optimal fixed-slot URL keeps the logical size and adapts DPR. The fluid option also uses <code>w_auto</code> with an accurate <code>sizes</code> rule so Cloudinary can adapt width. Both keep <code>f_auto</code> and <code>q_auto</code> last.";
  const dialogDetails = document.querySelector(".receipt-dialog-details");

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  requestAnimationFrame(() => {
    dialogDetails.scrollTop = 0;
    if (isFluid) updateFluidPreview(fluidPreviewWidth);
  });
};

const closeReceiptDialog = () => {
  const dialog = document.querySelector("#receipt-dialog");
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    activeReceiptKey = null;
    fluidResizeStart = null;
    lastReceiptTrigger?.focus();
    lastReceiptTrigger = null;
  }
};

const updateFileSizeSavings = () => {
  const original = metrics.get("original")?.bytes || 0;
  const optimized = metrics.get("baseline")?.bytes || 0;
  const note = document.querySelector("#file-size-savings");
  const originalFile = document.querySelector("#inspector-original-file");
  if (originalFile && original) originalFile.textContent = formatBytes(original);
  if (!note || !original || !optimized) {
    if (note) note.textContent = "Original-to-optimized byte savings will appear when Resource Timing exposes both responses.";
    return;
  }
  const reduction = Math.max(0, Math.round((1 - optimized / original) * 100));
  note.innerHTML = "<strong>Original source:</strong> " + formatBytes(original) + " &nbsp;→&nbsp; <strong>correctly optimized:</strong> " + formatBytes(optimized) + " &nbsp;·&nbsp; " + reduction + "% fewer bytes";
};

const updateAutoVerdict = () => {
  const auto = metrics.get("auto");
  const verdict = document.querySelector("#auto-verdict");
  if (!auto || !verdict) return;

  const requestedDpr = getRoundedDeviceDpr();
  const deliveredDpr = Math.round((auto.naturalWidth / BASE_WIDTH) * 10) / 10;
  const localFileMode = window.location.protocol === "file:";
  verdict.classList.remove("is-match", "is-fallback");

  if (localFileMode) {
    verdict.textContent = "Live 1× fallback: file:// pages cannot delegate the DPR client hint. See “Expected with setup” in the receipt for the deterministic device result.";
    verdict.classList.add("is-fallback");
    document.querySelector("#hint-status").textContent = "Local 1× fallback";
  } else if (Math.abs(deliveredDpr - requestedDpr) < 0.1) {
    verdict.textContent = `Matched: this browser received a ${deliveredDpr.toFixed(0)}× asset for a ${window.devicePixelRatio.toFixed(2)}× screen.`;
    verdict.classList.add("is-match");
    document.querySelector("#hint-status").textContent = "Active";
  } else if (deliveredDpr === 1 && requestedDpr > 1) {
    let deliveryOrigin = "the image delivery origin";
    try { deliveryOrigin = new URL(receiptUrls.auto).origin; } catch { /* Keep the readable fallback. */ }
    verdict.textContent = activeScanAnalysisContext?.fromScan && deliveryOrigin !== "https://res.cloudinary.com"
      ? `Live 1× fallback: ${deliveryOrigin} was discovered after this page loaded. The receipt’s “Expected with setup” row uses the scraped page layout to show the ${requestedDpr}× result.`
      : `Live 1× fallback: the DPR hint was unavailable. The receipt’s “Expected with setup” row shows the deterministic ${requestedDpr}× result.`;
    verdict.classList.add("is-fallback");
    document.querySelector("#hint-status").textContent = "1× fallback";
  } else {
    verdict.textContent = `Received ${deliveredDpr.toFixed(1)}× output; the current rounded device target is ${requestedDpr}×.`;
    verdict.classList.add("is-fallback");
    document.querySelector("#hint-status").textContent = "Check result";
  }
};

const updateTimingNote = () => {
  const note = document.querySelector("#timing-note");
  const measurementKeys = ["original", "baseline", "fixed", "auto", "fluid"];
  if (receiptUrls.autoExpected) measurementKeys.push("autoExpected");
  const receiptMeasurements = measurementKeys.map((key) => metrics.get(key));
  const hasFileSizes = receiptMeasurements.every((measurement) => measurement?.bytes > 0);
  const hasNetworkTransfers = receiptMeasurements.every((measurement) => measurement?.transferBytes > 0);
  note.innerHTML = hasNetworkTransfers
    ? '<span class="live-dot" aria-hidden="true"></span> Live dimensions, encoded file sizes, and network bandwidth measured successfully.'
    : hasFileSizes
      ? '<span class="live-dot" aria-hidden="true"></span> File sizes are live. Cache hits or Resource Timing restrictions may hide network bandwidth.'
      : '<span class="live-dot" aria-hidden="true"></span> Dimensions are live. File and transfer byte totals are restricted in this browser session.';
};

const measureAll = async () => {
  const run = ++measurementRun;
  const images = [...document.querySelectorAll("img[data-metric]")]
    .filter((image) => image.hasAttribute("src"));
  await Promise.all(images.map(imageReady));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (run !== measurementRun) return;
  images.forEach(measureImage);
  updateRuleSectionMeasurements();
  updateResultTable();
  updateEfficiencyVerdict();
  updateFileSizeSavings();
  updateAutoVerdict();
  updateTimingNote();
};

const refreshExpectedAssetForDevice = () => {
  const targetDpr = getRoundedDeviceDpr();
  if (targetDpr === expectedDprTarget) return false;
  if (activeAssetParsed) {
    const audit = buildAudit(activeAssetParsed, activeScanAnalysisContext);
    updateDemoAssets(activeAssetParsed, activeScanAnalysisContext, audit);
  } else {
    expectedDprTarget = targetDpr;
  }
  if (domainScanCandidates.length && domainScanPageUrl) {
    domainScanCandidates = domainScanCandidates.map((candidate) => ({
      ...candidate,
      recommendation: getScannedUrlRecommendation(candidate.url, candidate.layout) || candidate.recommendation
    }));
    renderDomainScanPage();
  }
  return true;
};

let deviceDprMediaQuery = null;
let deviceDprListener = null;
const watchDeviceDprChanges = () => {
  const listener = () => {
    refreshExpectedAssetForDevice();
    measureAll();
    watchDeviceDprChanges();
  };
  if (deviceDprMediaQuery && deviceDprListener) {
    if (typeof deviceDprMediaQuery.removeEventListener === "function") deviceDprMediaQuery.removeEventListener("change", deviceDprListener);
    else deviceDprMediaQuery.removeListener?.(deviceDprListener);
  }
  deviceDprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  deviceDprListener = listener;
  if (typeof deviceDprMediaQuery.addEventListener === "function") deviceDprMediaQuery.addEventListener("change", listener);
  else deviceDprMediaQuery.addListener?.(listener);
};

const updateDeviceReadout = () => {
  const dpr = window.devicePixelRatio || 1;
  document.querySelector("#device-dpr").textContent = dpr.toFixed(dpr % 1 ? 2 : 0);
  document.querySelector("#viewport-size").textContent = `${window.innerWidth} × ${window.innerHeight}`;
  document.querySelector("#auto-target").textContent = `${Math.ceil(dpr)}× (${BASE_WIDTH * Math.ceil(dpr)} px)`;

  const isChromium = /Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(navigator.userAgent) && !/Firefox|FxiOS/.test(navigator.userAgent);
  const localFileMode = window.location.protocol === "file:";
  document.querySelector("#browser-note").textContent = localFileMode
    ? "Local file mode. Everything runs here, but browser security prevents DPR client-hint delegation, so dpr_auto demonstrates its 1× fallback."
    : isChromium
      ? "Chromium detected. The loaded dpr_auto output below confirms whether the delegated hint reached Cloudinary."
      : "This browser may use Cloudinary’s 1× fallback because server-side DPR hints currently require Chromium.";
};

const isPrivatePageHostname = (rawHostname) => {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return true;

  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return ipv4[0] === 0
    || ipv4[0] === 10
    || ipv4[0] === 127
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168);
};

const normalizePageUrl = (rawValue) => {
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

const getCanonicalPageUrl = (readerData, fallbackUrl) => {
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

const fetchReaderData = async (pageUrl, { metadataOnly = false, signal } = {}) => {
  const response = await fetch(`${DOMAIN_READER_ORIGIN}${pageUrl.href}`, {
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

const fetchReaderHtml = async (pageUrl, { signal } = {}) => {
  const response = await fetch(`${DOMAIN_READER_ORIGIN}${pageUrl.href}`, {
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
  if (!response.ok) return "";
  const payload = await response.json();
  return payload?.data?.html || payload?.data?.content || "";
};

const stripMarkdownUrlDelimiter = (candidate) => {
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

const extractCloudinaryImageUrls = (content) => {
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

const normalizeScrapedAssetUrl = (rawUrl, pageUrl) => {
  try {
    const url = new URL(rawUrl, pageUrl);
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
};

const extractSrcsetUrls = (srcset) => {
  const urls = [];
  const matcher = /((?:https?:)?\/\/\S+?)(?=\s+\d+(?:\.\d+)?[wx](?:\s*,|$))/gi;
  let match;
  while ((match = matcher.exec(srcset))) urls.push(match[1]);
  return urls;
};

const extractScrapedImageElements = (html, pageUrl) => {
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

const detectCloudinaryClientSideHelper = (html) => {
  if (!html || typeof DOMParser === "undefined") {
    return {
      status: "unknown",
      evidence: "The source HTML was unavailable, so helper presence could not be verified."
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

const describeScannedCloudinaryUrl = (url, recommendation = getScannedUrlRecommendation(url)) => {
  try {
    const parsed = parseCloudinaryUrl(url);
    return recommendation
      ? `${parsed.url.hostname} · ${recommendation.dprLabel} · ${recommendation.title}`
      : `${parsed.url.hostname} · No optimization recommendation`;
  } catch {
    return new URL(url).hostname;
  }
};

const orderDomainScanCandidates = (candidates, order) => {
  const ordered = [...candidates];
  const byFoundOrder = (first, second) => first.foundOrder - second.foundOrder;
  if (order === "page-desc") return ordered.sort((first, second) => second.foundOrder - first.foundOrder);
  if (order === "page-asc") return ordered.sort(byFoundOrder);
  if (order === "potential-asc") {
    return ordered.sort((first, second) => first.recommendation.score - second.recommendation.score || byFoundOrder(first, second));
  }
  return ordered.sort((first, second) => second.recommendation.score - first.recommendation.score || byFoundOrder(first, second));
};

const setDomainScanStatus = (message, state = "") => {
  const status = document.querySelector("#domain-scan-status");
  status.className = "domain-scan-status";
  if (state) status.classList.add(`is-${state}`);
  status.textContent = message;
};

const clearDomainScanResults = ({ clearInput = false } = {}) => {
  domainScanCandidates = [];
  domainScanPageUrl = null;
  domainScanPage = 1;
  activeScanAnalysisContext = null;
  document.querySelector("#domain-scan-list").replaceChildren();
  document.querySelector("#domain-scan-results").hidden = true;
  document.querySelector("#inspector-result").hidden = true;
  document.querySelector("#domain-scan-count").textContent = "0 DPR candidates found";
  document.querySelector("#domain-scan-pagination").hidden = true;
  document.querySelector("#domain-scan-page-status").textContent = "Page 1 of 1";
  setDomainScanStatus("");
  if (clearInput) document.querySelector("#domain-url").value = "";
};

const renderDomainScanPage = () => {
  const results = document.querySelector("#domain-scan-results");
  const list = document.querySelector("#domain-scan-list");
  const count = document.querySelector("#domain-scan-count");
  const pagination = document.querySelector("#domain-scan-pagination");
  const orderSelect = document.querySelector("#domain-scan-order");
  const orderedCandidates = orderDomainScanCandidates(domainScanCandidates, orderSelect.value);
  const limitValue = Number(document.querySelector("#domain-scan-limit").value);
  const limit = [5, 10, 25, 50].includes(limitValue) ? limitValue : DOMAIN_SCAN_DEFAULT_LIMIT;
  const totalPages = Math.max(1, Math.ceil(orderedCandidates.length / limit));
  domainScanPage = Math.min(Math.max(1, domainScanPage), totalPages);
  const startIndex = (domainScanPage - 1) * limit;
  const endIndex = Math.min(startIndex + limit, orderedCandidates.length);
  const visibleCandidates = orderedCandidates.slice(startIndex, endIndex);
  list.replaceChildren();

  visibleCandidates.forEach((candidate, visibleIndex) => {
    const { url, recommendation, layout, clientSideHelper } = candidate;
    const resultIndex = startIndex + visibleIndex;
    const item = document.createElement("li");
    item.className = "domain-scan-result";

    const number = document.createElement("span");
    number.className = "domain-scan-index";
    number.textContent = String(resultIndex + 1);

    const thumbnail = document.createElement("div");
    thumbnail.className = "domain-scan-thumbnail";
    const thumbnailImage = document.createElement("img");
    thumbnailImage.alt = `Preview of Cloudinary image ${resultIndex + 1}`;
    thumbnailImage.decoding = "async";
    const thumbnailState = document.createElement("span");
    thumbnailState.textContent = "Loading preview…";
    thumbnailImage.addEventListener("load", () => thumbnail.classList.add("is-loaded"));
    let thumbnailAttempts = 0;
    const retryThumbnail = () => {
      if (!thumbnail.isConnected) return;
      thumbnailImage.removeAttribute("src");
      requestAnimationFrame(() => {
        if (thumbnail.isConnected) thumbnailImage.src = url;
      });
    };
    thumbnailImage.addEventListener("error", () => {
      if (thumbnailAttempts < 2) {
        const retryDelay = thumbnailAttempts === 0 ? 700 : 1800;
        thumbnailAttempts += 1;
        thumbnailState.textContent = `Retrying preview… (${thumbnailAttempts}/2)`;
        window.setTimeout(retryThumbnail, retryDelay);
        return;
      }
      thumbnail.classList.add("is-error");
      thumbnailState.textContent = "Preview unavailable after 3 attempts";
    });
    thumbnail.append(thumbnailImage, thumbnailState);
    thumbnailImage.src = url;

    const copy = document.createElement("div");
    copy.className = "domain-scan-result-copy";
    const urlText = document.createElement("code");
    urlText.className = "domain-scan-url";
    urlText.textContent = url;
    urlText.title = url;
    const detail = document.createElement("span");
    detail.className = "domain-scan-detail";
    detail.textContent = describeScannedCloudinaryUrl(url, recommendation);
    const score = document.createElement("span");
    score.className = "domain-scan-score";
    score.classList.toggle("is-high", recommendation.score >= 80);
    score.classList.toggle("is-low", recommendation.score <= 30);
    score.title = `${recommendation.errorCount} errors, ${recommendation.warningCount} warnings, and ${recommendation.opportunityCount} generated opportunities. Higher scores indicate more actionable optimization potential.`;
    score.append("Optimization potential ");
    const scoreValue = document.createElement("strong");
    scoreValue.textContent = `${recommendation.score}%`;
    score.append(scoreValue);
    const deliveryOrigin = document.createElement("span");
    deliveryOrigin.className = "domain-scan-origin";
    try {
      const origin = new URL(url).origin;
      const customOrigin = origin !== "https://res.cloudinary.com";
      deliveryOrigin.classList.toggle("is-custom", customOrigin);
      deliveryOrigin.textContent = customOrigin
        ? `Found #${candidate.foundOrder + 1} · custom delivery origin · verify Sec-CH-DPR delegation to ${origin}`
        : `Found #${candidate.foundOrder + 1} · client-hint origin · verify Sec-CH-DPR delegation to ${origin}`;
    } catch {
      deliveryOrigin.textContent = "Verify client-hint delegation for this delivery origin";
    }
    const helperStatus = document.createElement("span");
    helperStatus.className = "domain-scan-helper";
    helperStatus.classList.toggle("is-detected", clientSideHelper?.status === "detected");
    helperStatus.classList.toggle("is-unknown", clientSideHelper?.status === "unknown");
    helperStatus.textContent = clientSideHelper?.status === "detected"
      ? "Client-side helper: detected"
      : clientSideHelper?.status === "unknown"
        ? "Client-side helper: could not verify"
        : "Client-side helper: missing";
    helperStatus.title = clientSideHelper?.evidence || "";
    const simulation = recommendation.automaticSimulation;
    const layoutSummary = document.createElement("span");
    layoutSummary.className = "domain-scan-layout";
    const layoutTitle = document.createElement("strong");
    layoutTitle.textContent = "Scraped page layout: ";
    layoutSummary.append(layoutTitle, layout?.description || "No reliable page dimensions were found");
    const simulationSummary = document.createElement("span");
    simulationSummary.className = "domain-scan-simulation";
    if (simulation) {
      const simulationTitle = document.createElement("strong");
      simulationTitle.textContent = `Expected auto on this device: ${simulation.targetDpr}×`;
      simulationSummary.append(simulationTitle, ` · ${simulation.projectedLabel} · simulated without source-page client hints`);
    } else {
      simulationSummary.textContent = "Automatic DPR projection is unavailable for this transformation.";
    }
    copy.append(urlText, detail, score, deliveryOrigin, helperStatus, layoutSummary, simulationSummary);

    const actions = document.createElement("div");
    actions.className = "domain-scan-actions";
    const analyze = document.createElement("button");
    analyze.type = "button";
    analyze.dataset.analyzeUrl = url;
    analyze.dataset.sourcePageUrl = domainScanPageUrl?.href || "";
    analyze.textContent = "Analyze";
    analyze.setAttribute("aria-label", `Analyze Cloudinary image ${resultIndex + 1}`);
    const open = document.createElement("a");
    open.href = url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = "Open ↗";
    open.setAttribute("aria-label", `Open Cloudinary image ${resultIndex + 1} in a new tab`);
    actions.append(analyze);
    if (simulation?.canPreview) {
      const openSimulation = document.createElement("a");
      openSimulation.href = simulation.url;
      openSimulation.target = "_blank";
      openSimulation.rel = "noreferrer";
      openSimulation.textContent = "Auto preview ↗";
      openSimulation.setAttribute("aria-label", `Open the simulated automatic DPR output for Cloudinary image ${resultIndex + 1}`);
      actions.append(openSimulation);
    }
    actions.append(open);

    item.append(number, thumbnail, copy, actions);
    list.append(item);
  });

  const hostname = domainScanPageUrl?.hostname || "this page";
  const orderLabel = orderSelect.selectedOptions[0]?.textContent || "Most potential optimizations";
  count.textContent = domainScanCandidates.length
    ? `Showing ${startIndex + 1}–${endIndex} of ${domainScanCandidates.length} DPR candidates found on ${hostname} · ${orderLabel}`
    : `0 DPR optimization candidates found on ${hostname}`;
  pagination.hidden = totalPages <= 1;
  document.querySelector("#domain-scan-page-status").textContent = `Page ${domainScanPage} of ${totalPages}`;
  document.querySelector("#domain-scan-previous").disabled = domainScanPage <= 1;
  document.querySelector("#domain-scan-next").disabled = domainScanPage >= totalPages;
  results.hidden = false;
};

const renderDomainScanResults = (candidates, pageUrl) => {
  domainScanCandidates = [...candidates];
  domainScanPageUrl = pageUrl;
  domainScanPage = 1;
  renderDomainScanPage();
};

const scanPageForCloudinaryUrls = async (rawValue) => {
  const run = ++domainScanRun;
  const button = document.querySelector("#domain-scan-button");
  domainScanController?.abort();
  domainScanController = null;
  button.disabled = false;
  button.textContent = "Scan page";

  const pageUrl = normalizePageUrl(rawValue);
  const input = document.querySelector("#domain-url");
  input.value = pageUrl.href;
  const controller = new AbortController();
  domainScanController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 55000);

  clearDomainScanResults();
  button.disabled = true;
  button.textContent = "Scanning…";
  setDomainScanStatus(`Checking ${pageUrl.href} for redirects and canonical page metadata…`, "loading");

  try {
    let canonicalPageUrl = pageUrl;
    try {
      const metadata = await fetchReaderData(pageUrl, { metadataOnly: true, signal: controller.signal });
      if (run !== domainScanRun) return;
      canonicalPageUrl = getCanonicalPageUrl(metadata, pageUrl);
      input.value = canonicalPageUrl.href;
      setDomainScanStatus(
        canonicalPageUrl.href !== pageUrl.href
          ? `Canonical redirect found: ${pageUrl.href} → ${canonicalPageUrl.href}. Rendering the canonical page and waiting for lazy-loaded images; this can take up to 20 seconds…`
          : `No canonical redirect found. Rendering ${canonicalPageUrl.href} and waiting for lazy-loaded images; this can take up to 20 seconds…`,
        "loading"
      );
    } catch (error) {
      if (error.name === "AbortError" || error.status === 429) throw error;
      setDomainScanStatus(
        `The quick redirect check was unavailable. Rendering ${pageUrl.href} directly and waiting for lazy-loaded images; this can take up to 20 seconds…`,
        "loading"
      );
    }

    const [readerData, pageHtml] = await Promise.all([
      fetchReaderData(canonicalPageUrl, { signal: controller.signal }),
      fetchReaderHtml(canonicalPageUrl, { signal: controller.signal }).catch(() => "")
    ]);
    const content = readerData?.content;
    if (typeof content !== "string") throw new Error("The page reader returned an incomplete browser snapshot.");
    if (run !== domainScanRun) return;
    canonicalPageUrl = getCanonicalPageUrl(readerData, canonicalPageUrl);
    input.value = canonicalPageUrl.href;
    const pageImageElements = extractScrapedImageElements(pageHtml, canonicalPageUrl);
    const clientSideHelper = detectCloudinaryClientSideHelper(pageHtml);
    const candidates = extractCloudinaryImageUrls(content)
      .map((url) => {
        const elementContext = pageImageElements.get(normalizeScrapedAssetUrl(url));
        const layout = buildScrapedLayoutContext(url, elementContext);
        return { url, layout, clientSideHelper, recommendation: getScannedUrlRecommendation(url, layout) };
      })
      .filter((candidate) => candidate.recommendation)
      .map((candidate, foundOrder) => ({ ...candidate, foundOrder }));
    renderDomainScanResults(candidates, canonicalPageUrl);
    const canonicalNote = canonicalPageUrl.href !== pageUrl.href
      ? ` Canonical page: ${canonicalPageUrl.href}`
      : "";
    setDomainScanStatus(
      candidates.length
        ? `Scan complete.${canonicalNote} Choose any result to load it into the optimizer.`
        : `Scan complete.${canonicalNote} No Cloudinary URLs with DPR recommendations were found on this page.`,
      candidates.length ? "success" : ""
    );
  } catch (error) {
    if (run !== domainScanRun) return;
    const message = error.name === "AbortError"
      ? "The page scan timed out. Try again or scan a more specific public page."
      : error.message || "The page could not be scanned.";
    clearDomainScanResults();
    setDomainScanStatus(message, "error");
  } finally {
    window.clearTimeout(timeout);
    if (run === domainScanRun) {
      button.disabled = false;
      button.textContent = "Scan page";
      domainScanController = null;
    }
  }
};

const configureRuleSection = (parsed, scanContext, expectedSimulation, fallbackUrl) => {
  const usesScannedLayout = Boolean(scanContext?.fromScan && expectedSimulation.usedPageLayout);
  const displayWidth = usesScannedLayout ? expectedSimulation.logicalWidth : BASE_WIDTH;
  const displayHeight = usesScannedLayout ? expectedSimulation.logicalHeight : BASE_HEIGHT;
  const deliveryUrl = scanContext?.fromScan ? parsed.raw : fallbackUrl;
  const layoutSource = usesScannedLayout
    ? scanContext.layout?.source || "scanned page layout"
    : scanContext?.fromScan
      ? "No usable displayed dimensions were found in the scanned page"
      : "Lab comparison slot";
  const wrongImage = document.querySelector('[data-metric="wrong"]');
  const correctImage = document.querySelector('[data-metric="correct"]');
  const outline = document.querySelector("#rule-expected-outline");
  const displayLabel = formatDimensions(displayWidth, displayHeight);
  const wrongMarkup = `<img src="${deliveryUrl}" alt="">`;
  const correctMarkup = `<img src="${deliveryUrl}" width="${displayWidth}" height="${displayHeight}" alt="">`;

  activeRuleContext = {
    fromScan: Boolean(scanContext?.fromScan),
    usesScannedLayout,
    deliveryUrl,
    displayWidth,
    displayHeight,
    layoutSource,
    sourcePageUrl: scanContext?.sourcePageUrl || ""
  };

  wrongImage.src = deliveryUrl;
  wrongImage.removeAttribute("width");
  wrongImage.removeAttribute("height");
  correctImage.src = deliveryUrl;
  correctImage.width = displayWidth;
  correctImage.height = displayHeight;
  outline.style.width = `${displayWidth}px`;
  outline.style.height = `${displayHeight}px`;
  document.querySelector("#rule-expected-label").innerHTML =
    `${usesScannedLayout ? "Scanned page display" : "Fallback display"}<br>${displayLabel} CSS px`;
  document.querySelector("#rule-correct-status").textContent = usesScannedLayout
    ? `Scanned dimensions · ${layoutSource}`
    : "Fallback dimensions declared";
  document.querySelector("#rule-section-summary").textContent = scanContext?.fromScan
    ? "Loading the exact selected delivery URL and measuring its response against the scanned page display dimensions…"
    : "Both examples request the exact same 2× Cloudinary asset. Only one tells the browser the desired final display dimensions.";
  document.querySelector("#rule-correct-heading").textContent = scanContext?.fromScan
    ? "Measuring delivered density at the scanned display size…"
    : "2× pixels, displayed at 1× size";
  document.querySelector("#rule-wrong-code").textContent = wrongMarkup;
  document.querySelector("#rule-wrong-copy").dataset.copy = wrongMarkup;
  document.querySelector("#rule-correct-code").textContent = correctMarkup;
  document.querySelector("#rule-correct-copy").dataset.copy = correctMarkup;
  document.querySelector("#rule-wrong-description").textContent = "Loading the exact selected delivery URL to measure its response dimensions…";
  document.querySelector("#rule-correct-description").textContent = usesScannedLayout
    ? `Loading the same response at the ${displayLabel} CSS-pixel slot retrieved from the scanned page…`
    : `The scan did not expose usable display dimensions, so this preview explicitly uses the ${displayLabel} lab fallback.`;
  ["wrong", "correct"].forEach((key) => {
    metrics.delete(key);
    ["natural", "rendered", "effective", "bytes"].forEach((value) => setMetricText(key, value, "—"));
  });
};

const updateRuleSectionMeasurements = () => {
  if (!activeRuleContext) return;
  const delivered = metrics.get("wrong");
  const displayed = metrics.get("correct");
  if (!delivered?.naturalWidth || !delivered?.naturalHeight) return;

  const deliveredLabel = formatDimensions(delivered.naturalWidth, delivered.naturalHeight);
  const displayLabel = formatDimensions(activeRuleContext.displayWidth, activeRuleContext.displayHeight);
  const effectiveDpr = displayed?.effectiveDensity || delivered.naturalWidth / activeRuleContext.displayWidth;
  const pageLabel = activeRuleContext.sourcePageUrl || "the scanned page";

  document.querySelector("#rule-section-summary").textContent = activeRuleContext.fromScan
    ? activeRuleContext.usesScannedLayout
      ? `Both examples use the exact delivery URL selected from ${pageLabel}. Its response delivers ${deliveredLabel} pixels and the scanned page displays it at ${displayLabel} CSS pixels.`
      : `Both examples use the exact delivery URL selected from ${pageLabel} and its measured ${deliveredLabel}-pixel response. The scan did not expose usable displayed dimensions, so the constrained example is clearly marked as a ${displayLabel} fallback.`
    : "Both examples request the exact same 2× Cloudinary asset. Only one tells the browser the desired final display dimensions.";
  document.querySelector("#rule-wrong-description").textContent =
    `The selected URL delivers ${deliveredLabel} pixels. Without a display constraint, the browser uses the resource’s natural size: ${deliveredLabel} CSS pixels. The dashed outline shows the ${displayLabel} target.`;
  document.querySelector("#rule-correct-heading").textContent = activeRuleContext.usesScannedLayout
    ? `${effectiveDpr.toFixed(1)}× delivered density at the scanned display size`
    : `${effectiveDpr.toFixed(1)}× delivered density at the fallback display size`;
  document.querySelector("#rule-correct-description").textContent = activeRuleContext.usesScannedLayout
    ? `The same ${deliveredLabel} response is constrained to the ${displayLabel} CSS-pixel slot retrieved from the page (${activeRuleContext.layoutSource}).`
    : `The same ${deliveredLabel} response is constrained to ${displayLabel} CSS pixels. ${activeRuleContext.layoutSource}, so this is a disclosed lab fallback rather than a scanned display measurement.`;
};

const updateDemoAssets = (parsed, scanContext = null, audit = buildAudit(parsed, scanContext)) => {
  const logicalTransform = "c_fill,g_auto,w_360,h_240";
  const targetDpr = getRoundedDeviceDpr();
  const expectedFallbackTransform = targetDpr > 1
    ? `${logicalTransform},dpr_${targetDpr.toFixed(1)}`
    : logicalTransform;
  const layoutSimulation = scanContext?.fromScan
    ? buildAutomaticDprSimulation(parsed, audit, scanContext.layout)
    : null;
  const expectedSimulation = layoutSimulation || {
    targetDpr,
    deviceDpr: window.devicePixelRatio || 1,
    url: buildDeliveryUrl(parsed, [expectedFallbackTransform, "f_auto", "q_auto"]),
    productionUrl: buildDeliveryUrl(parsed, [`${logicalTransform},dpr_auto`, "f_auto", "q_auto"]),
    projectedLabel: formatDimensions(BASE_WIDTH * targetDpr, BASE_HEIGHT * targetDpr),
    sizingBasis: `${formatDimensions(BASE_WIDTH, BASE_HEIGHT)} · lab comparison slot`,
    logicalWidth: BASE_WIDTH,
    logicalHeight: BASE_HEIGHT,
    layoutContext: null,
    canPreview: true,
    isSigned: false,
    usedWidthFallback: false,
    usedPageLayout: false
  };
  const sourceUrls = {
    original: buildDeliveryUrl(parsed, []),
    baseline: buildDeliveryUrl(parsed, [logicalTransform, "f_auto", "q_auto"]),
    fixed: buildDeliveryUrl(parsed, [`${logicalTransform},dpr_2.0`, "f_auto", "q_auto"]),
    auto: buildDeliveryUrl(parsed, [`${logicalTransform},dpr_auto`, "f_auto", "q_auto"]),
    autoExpected: expectedSimulation.canPreview ? expectedSimulation.url : "",
    fluid: buildDeliveryUrl(parsed, ["ar_3:2,c_fill,g_auto", `c_limit,w_auto:40:${BASE_WIDTH},dpr_auto`, "f_auto", "q_auto"])
  };

  activeAssetParsed = parsed;
  activeExpectedSimulation = expectedSimulation;
  expectedDprTarget = targetDpr;

  document.querySelector('[data-metric="original"]').src = sourceUrls.original;
  document.querySelector('[data-metric="baseline"]').src = sourceUrls.baseline;
  document.querySelector('[data-metric="fixed"]').src = sourceUrls.fixed;
  document.querySelector('[data-metric="auto"]').src = sourceUrls.auto;
  const expectedImage = document.querySelector('[data-metric="autoExpected"]');
  if (sourceUrls.autoExpected) {
    expectedImage.src = sourceUrls.autoExpected;
    expectedImage.style.width = expectedSimulation.logicalWidth ? `${expectedSimulation.logicalWidth}px` : "auto";
    expectedImage.style.height = expectedSimulation.logicalHeight ? `${expectedSimulation.logicalHeight}px` : "auto";
    if (expectedSimulation.logicalWidth) expectedImage.width = expectedSimulation.logicalWidth;
    else expectedImage.removeAttribute("width");
    if (expectedSimulation.logicalHeight) expectedImage.height = expectedSimulation.logicalHeight;
    else expectedImage.removeAttribute("height");
  } else {
    expectedImage.removeAttribute("src");
    metrics.delete("autoExpected");
    const expectedRow = document.querySelector('[data-result-row="autoExpected"]');
    expectedRow.querySelectorAll("[data-result]").forEach((cell) => { cell.textContent = "Unavailable"; });
  }
  document.querySelector('[data-metric="fluid"]').src = sourceUrls.fluid;
  configureRuleSection(parsed, scanContext, expectedSimulation, sourceUrls.fixed);
  Object.assign(receiptUrls, sourceUrls);

  const expectedContext = expectedSimulation.usedPageLayout && scanContext?.layout
    ? scanContext.layout.description
    : `Lab comparison slot · ${formatDimensions(expectedSimulation.logicalWidth, expectedSimulation.logicalHeight)}`;
  document.querySelector("#auto-expected-label").textContent = expectedSimulation.usedPageLayout
    ? "Expected automatic output for scraped page"
    : "Expected automatic output for analyzed slot";
  document.querySelector("#auto-expected-context").textContent = expectedContext;
  document.querySelector("#auto-expected-badge").textContent = `Expected with setup · ${targetDpr}×`;
  document.querySelector("#auto-expected-setting").textContent = targetDpr === 1
    ? "DPR omitted · 1× diagnostic"
    : `dpr_${targetDpr.toFixed(1)} diagnostic`;

  const fluidMarkup = buildFluidMarkup(sourceUrls.fluid);
  document.querySelector("#receipt-fluid-url").textContent = sourceUrls.fluid;
  document.querySelector("#receipt-fluid-markup").textContent = fluidMarkup;
  document.querySelector("#receipt-fluid-link").href = sourceUrls.fluid;
  document.querySelector("#responsive-sizing-url").textContent = sourceUrls.fluid;
  document.querySelector("#responsive-sizing-markup").textContent = fluidMarkup;

  const assetName = decodeURIComponent(parsed.assetSegments.at(-1) || "selected asset");
  document.querySelector("#demo-source-note").textContent =
    `All examples below use “${assetName}”, displayed at 360 × 240 CSS pixels. Compare its delivered dimensions and bytes on your current screen.`;
};

const renderTransformationList = (segments) => {
  const container = document.querySelector("#transformation-list");
  container.replaceChildren();
  if (!segments.length) {
    const empty = document.createElement("code");
    empty.className = "empty-transform";
    empty.textContent = "No transformations detected";
    container.append(empty);
    return;
  }
  segments.forEach((segment) => {
    const chip = document.createElement("code");
    chip.textContent = segment;
    container.append(chip);
  });
};

const renderIssues = (issues) => {
  const list = document.querySelector("#issue-list");
  list.replaceChildren();
  orderAuditIssues(issues).forEach((issue) => {
    const item = document.createElement("li");
    item.dataset.severity = issue.severity;
    const title = document.createElement("strong");
    title.textContent = issue.title;
    const description = document.createElement("span");
    description.textContent = issue.text;
    item.append(title, description);
    if (issue.suggestion) {
      const suggestion = document.createElement("code");
      suggestion.textContent = issue.suggestion;
      suggestion.style.display = "block";
      suggestion.style.marginTop = "7px";
      item.append(suggestion);
    }
    list.append(item);
  });
};

const setAuditVerdict = (issues) => {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const verdict = document.querySelector("#audit-verdict");
  verdict.classList.remove("is-bad", "is-warning", "is-good");

  if (errors) {
    verdict.textContent = "Needs fixes";
    verdict.classList.add("is-bad");
  } else if (warnings) {
    verdict.textContent = "Review";
    verdict.classList.add("is-warning");
  } else {
    verdict.textContent = "Looks good";
    verdict.classList.add("is-good");
  }
  document.querySelector("#audit-title").textContent = `${errors + warnings} actionable ${errors + warnings === 1 ? "finding" : "findings"}`;
};

const updateInspectorMarkup = (audit, deliveredWidth, deliveredHeight) => {
  const fixedSizeUrl = audit.responsiveUrl || audit.correctedUrl;
  let logicalWidth = audit.width || audit.autoWidth.fallback;
  let logicalHeight = audit.height;
  const ratio = deliveredWidth && deliveredHeight ? deliveredHeight / deliveredWidth : 0;

  if (!logicalWidth && logicalHeight && ratio) logicalWidth = Math.round(logicalHeight / ratio);
  if (!logicalHeight && logicalWidth && ratio) logicalHeight = Math.round(logicalWidth * ratio);

  const dimensions = [
    logicalWidth ? `width="${Math.round(logicalWidth)}"` : "",
    logicalHeight ? `height="${Math.round(logicalHeight)}"` : ""
  ].filter(Boolean).join(" ");
  const sizes = audit.autoWidth.token
    ? logicalWidth ? ` sizes="(max-width: ${Math.round(logicalWidth)}px) 100vw, ${Math.round(logicalWidth)}px"` : ' sizes="100vw"'
    : "";
  document.querySelector("#suggested-markup").textContent =
    `<img src="${fixedSizeUrl}"${sizes}${dimensions ? ` ${dimensions}` : ""} alt="">`;
};

const updateResponsiveWidthMarkup = (audit, deliveredWidth, deliveredHeight) => {
  const output = document.querySelector("#responsive-width-markup");
  if (!audit.responsiveWidthUrl) {
    output.textContent = "—";
    return;
  }

  const logicalWidth = Math.round(audit.width);
  const ratio = deliveredWidth && deliveredHeight ? deliveredHeight / deliveredWidth : 0;
  const logicalHeight = audit.height || (ratio ? Math.round(logicalWidth * ratio) : 0);
  const dimensions = [
    `width="${logicalWidth}"`,
    logicalHeight ? `height="${Math.round(logicalHeight)}"` : ""
  ].filter(Boolean).join(" ");
  const sizes = `(max-width: ${logicalWidth}px) 100vw, ${logicalWidth}px`;
  output.textContent =
    `<img src="${audit.responsiveWidthUrl}" sizes="${sizes}" ${dimensions} style="width:100%;max-width:${logicalWidth}px;height:auto" alt="">`;
};

const updateClientHintOption = (parsed, scanContext) => {
  const option = document.querySelector("#client-hint-option");
  option.hidden = !scanContext?.fromScan;
  if (option.hidden) return;

  const origin = parsed.url.origin;
  const setup = getClientHintSetup(origin);
  const sourcePage = scanContext.sourcePageUrl || "the scanned page";
  const isDelegatedByLab = origin === "https://res.cloudinary.com";
  document.querySelector("#client-hint-title").textContent = `Delegate DPR to ${parsed.url.hostname}`;
  document.querySelector("#client-hint-meta").textContent = setup.meta;
  document.querySelector("#client-hint-headers").textContent = setup.headers;
  document.querySelector("#client-hint-note").textContent = isDelegatedByLab
    ? `Apply one option to ${sourcePage}. Place delegate-ch before links, styles, scripts, and image requests, or send the HTTP headers with the HTML response.`
    : `Apply one option to ${sourcePage}. This custom delivery origin was discovered after the lab loaded, so the lab may measure dpr_auto as a 1× fallback even though the production page will adapt correctly after this setup.`;
};

const configureAutomaticDprSimulationOption = (parsed, audit, scanContext) => {
  const option = document.querySelector("#simulated-auto-option");
  const simulation = scanContext?.fromScan
    ? buildAutomaticDprSimulation(parsed, audit, scanContext.layout)
    : null;
  option.hidden = !simulation;
  if (!simulation) return null;

  const preview = document.querySelector("#simulated-auto-preview");
  const image = document.querySelector("#simulated-auto-image");
  const state = document.querySelector("#simulated-auto-state");
  const link = document.querySelector("#simulated-auto-link");
  document.querySelector("#simulated-auto-device-dpr").textContent = `${simulation.deviceDpr.toFixed(2)}×`;
  document.querySelector("#simulated-auto-target-dpr").textContent = `${simulation.targetDpr}× (rounded up)`;
  document.querySelector("#simulated-auto-width-basis").textContent = simulation.sizingBasis;
  document.querySelector("#simulated-auto-projected").textContent = simulation.projectedLabel;
  document.querySelector("#simulated-auto-actual").textContent = simulation.canPreview ? "Loading…" : "Unavailable";
  document.querySelector("#simulated-auto-bytes").textContent = simulation.canPreview ? "Loading…" : "Unavailable";
  link.hidden = !simulation.canPreview;

  if (!simulation.canPreview) {
    image.removeAttribute("src");
    preview.classList.remove("is-loading");
    preview.classList.add("is-error");
    state.textContent = simulation.isSigned
      ? "A new signed URL is required before this transformed preview can load."
      : "Add a logical width or height before simulating DPR output.";
    document.querySelector("#simulated-auto-url").textContent = simulation.isSigned
      ? "Unavailable: regenerate the signed URL for the resolved transformation"
      : "Unavailable: the URL has no deterministic delivery size";
    document.querySelector("#simulated-auto-note").textContent = simulation.isSigned
      ? "The expected DPR target is shown above, but changing a signed transformation invalidates its signature. Generate the resolved variant on the server before previewing it."
      : "The expected DPR target is shown above, but output dimensions require a logical delivery width or height. Add that sizing transformation, then keep dpr_auto in production.";
    return simulation;
  }

  link.href = simulation.url;
  document.querySelector("#simulated-auto-url").textContent = simulation.url;
  document.querySelector("#simulated-auto-note").innerHTML = simulation.usedPageLayout
    ? `This deterministic diagnostic resolves <code>dpr_auto</code> to ${simulation.targetDpr}× using the scraped page slot: ${simulation.sizingBasis}. It does not depend on the scanned page’s live client-hint request. Keep <code>dpr_auto</code> in production and apply the delegation setup above.`
    : simulation.usedWidthFallback
      ? `This deterministic diagnostic resolves <code>dpr_auto</code> to ${simulation.targetDpr}× and uses the URL’s <code>w_auto</code> fallback width. It does not depend on the scanned page’s client-hint setup. Keep <code>w_auto</code> and <code>dpr_auto</code> in production with accurate <code>sizes</code> and delegation.`
      : `This deterministic diagnostic resolves <code>dpr_auto</code> to ${simulation.targetDpr}×, so it does not depend on the scanned page’s client-hint setup. Keep <code>dpr_auto</code> in production and apply the delegation setup above.`;
  preview.classList.add("is-loading");
  preview.classList.remove("is-error");
  state.textContent = "Loading deterministic preview…";
  image.src = simulation.url;
  return simulation;
};

const updateAutomaticDprSimulationMeasurement = (simulation) => {
  if (!simulation?.canPreview) return;
  const preview = document.querySelector("#simulated-auto-preview");
  const image = document.querySelector("#simulated-auto-image");
  const state = document.querySelector("#simulated-auto-state");
  preview.classList.remove("is-loading", "is-error");

  if (!image.naturalWidth) {
    preview.classList.add("is-error");
    state.textContent = "The simulated transformation could not be loaded. Check delivery restrictions or generate the derived asset first.";
    document.querySelector("#simulated-auto-actual").textContent = "Could not load";
    document.querySelector("#simulated-auto-bytes").textContent = "Unavailable";
    return;
  }

  const resource = getResourceDetails(image.currentSrc || image.src);
  const deliveredWidth = resource.width || image.naturalWidth;
  const deliveredHeight = resource.height || image.naturalHeight;
  document.querySelector("#simulated-auto-actual").textContent = formatDimensions(deliveredWidth, deliveredHeight);
  document.querySelector("#simulated-auto-bytes").textContent = formatBytes(resource.bytes);
};

let inspectorRun = 0;

const analyzeAssetUrl = async (rawValue, scanContext) => {
  const run = ++inspectorRun;
  const preview = document.querySelector("#inspector-preview");
  const previewState = document.querySelector("#preview-state");
  const image = document.querySelector("#inspector-image");

  preview.classList.add("is-loading");
  preview.classList.remove("is-error");
  previewState.textContent = "Loading output…";
  document.querySelector("#inspector-delivered").textContent = "—";
  document.querySelector("#inspector-bytes").textContent = "—";
  document.querySelector("#inspector-original-file").textContent = "—";
  document.querySelector("#inspector-derived-file").textContent = "—";
  document.querySelector("#output-explanation").textContent = "Waiting for the asset response.";
  document.querySelector("#client-hint-option").hidden = true;
  document.querySelector("#simulated-auto-option").hidden = true;

  let parsed;
  try {
    parsed = parseCloudinaryUrl(rawValue);
  } catch (error) {
    preview.classList.remove("is-loading");
    preview.classList.add("is-error");
    previewState.textContent = "Unable to load this URL";
    renderTransformationList([]);
    renderIssues([{ severity: "error", title: "URL could not be inspected", text: error.message }]);
    setAuditVerdict([{ severity: "error" }]);
    document.querySelector("#audit-title").textContent = "Invalid delivery URL";
    document.querySelector("#corrected-url").textContent = "—";
    document.querySelector("#suggested-markup").textContent = "—";
    document.querySelector("#responsive-option").hidden = true;
    document.querySelector("#responsive-width-option").hidden = true;
    document.querySelector("#responsive-width-markup").textContent = "—";
    return;
  }

  const audit = buildAudit(parsed, scanContext);
  updateDemoAssets(parsed, scanContext, audit);
  measureAll();
  renderTransformationList(parsed.transformationSegments);
  renderIssues(audit.issues);
  setAuditVerdict(audit.issues);
  updateClientHintOption(parsed, scanContext);
  const automaticSimulation = configureAutomaticDprSimulationOption(parsed, audit, scanContext);

  document.querySelector("#current-asset-link").href = parsed.raw;
  document.querySelector("#corrected-url").textContent = audit.correctedUrl;
  document.querySelector("#corrected-asset-link").href = audit.correctedUrl;
  document.querySelector("#inspector-dpr").textContent = audit.dpr.label;

  const responsiveOption = document.querySelector("#responsive-option");
  responsiveOption.hidden = !audit.responsiveUrl;
  if (audit.responsiveUrl) {
    document.querySelector("#responsive-url").textContent = audit.responsiveUrl;
    document.querySelector("#responsive-asset-link").href = audit.responsiveUrl;
  }

  const responsiveWidthOption = document.querySelector("#responsive-width-option");
  responsiveWidthOption.hidden = !audit.responsiveWidthUrl;
  if (audit.responsiveWidthUrl) {
    document.querySelector("#responsive-width-url").textContent = audit.responsiveWidthUrl;
    document.querySelector("#responsive-width-asset-link").href = audit.responsiveWidthUrl;
  }

  updateInspectorMarkup(audit, 0, 0);
  updateResponsiveWidthMarkup(audit, 0, 0);
  image.src = parsed.raw;
  await Promise.all([
    imageReady(image),
    automaticSimulation?.canPreview
      ? imageReady(document.querySelector("#simulated-auto-image"))
      : Promise.resolve()
  ]);
  if (run !== inspectorRun) return;

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  updateAutomaticDprSimulationMeasurement(automaticSimulation);

  if (!image.naturalWidth) {
    preview.classList.remove("is-loading");
    preview.classList.add("is-error");
    previewState.textContent = "The asset could not be loaded";
    document.querySelector("#output-explanation").textContent = "Check access controls, the delivery URL, or whether this transformation is allowed.";
    return;
  }

  const resource = getResourceDetails(image.currentSrc || image.src);
  const deliveredWidth = resource.width || image.naturalWidth;
  const deliveredHeight = resource.height || image.naturalHeight;
  preview.classList.remove("is-loading", "is-error");
  document.querySelector("#inspector-delivered").textContent = formatDimensions(deliveredWidth, deliveredHeight);
  document.querySelector("#inspector-bytes").textContent = formatBytes(resource.bytes);
  document.querySelector("#inspector-derived-file").textContent = formatBytes(resource.bytes);
  updateInspectorMarkup(audit, deliveredWidth, deliveredHeight);
  updateResponsiveWidthMarkup(audit, deliveredWidth, deliveredHeight);

  if (audit.dpr.isExplicit && audit.width) {
    const predictedWidth = Math.round(audit.width * audit.dpr.value);
    document.querySelector("#output-explanation").textContent =
      `w_${audit.width} × DPR ${audit.dpr.value} requests ${predictedWidth} physical pixels wide. This response delivered ${formatDimensions(deliveredWidth, deliveredHeight)}.`;
  } else if (audit.dpr.isAuto) {
    const logicalWidth = audit.width || audit.autoWidth.fallback;
    const deliveredDpr = logicalWidth ? deliveredWidth / logicalWidth : 0;
    const targetDpr = getRoundedDeviceDpr();
    document.querySelector("#output-explanation").textContent = deliveredDpr && deliveredDpr + .05 < targetDpr
      ? `dpr_auto delivered ${deliveredDpr.toFixed(1)}× instead of this browser’s ${targetDpr}× target. The DPR client hint did not reach this delivery request; use the generated delegation setup for the exact image origin.`
      : `Cloudinary selected this ${formatDimensions(deliveredWidth, deliveredHeight)} response from the DPR client hint available in this browser context.`;
  } else {
    document.querySelector("#output-explanation").textContent =
      `The current URL delivered ${formatDimensions(deliveredWidth, deliveredHeight)} without a high-density DPR multiplier.`;
  }
};

document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select code";
    }
    setTimeout(() => { button.textContent = original; }, 1400);
  });
});

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.querySelector(`#${button.dataset.copyTarget}`);
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select code";
    }
    setTimeout(() => { button.textContent = original; }, 1400);
  });
});

document.querySelectorAll("[data-receipt-key]").forEach((button) => {
  button.addEventListener("click", () => openReceiptDialog(button.dataset.receiptKey, button));
});

document.querySelector("#receipt-dialog-close").addEventListener("click", closeReceiptDialog);
document.querySelector("#receipt-dialog").addEventListener("close", () => {
  activeReceiptKey = null;
  fluidResizeStart = null;
  lastReceiptTrigger?.focus();
  lastReceiptTrigger = null;
});

document.querySelector("#receipt-dialog-image").addEventListener("load", () => {
  requestAnimationFrame(updateFluidActualOutput);
});
document.querySelector("#receipt-dialog-image").addEventListener("error", () => {
  if (activeReceiptKey !== "fluid") return;
  document.querySelector("#receipt-fluid-actual-output").textContent = "Could not load preview";
  document.querySelector("#receipt-fluid-file-size").textContent = "Unavailable";
  document.querySelector("#receipt-fluid-bandwidth").textContent = "Unavailable";
});

document.querySelector("#receipt-fluid-width-range").addEventListener("input", (event) => {
  updateFluidPreview(Number(event.target.value));
});

const fluidResizeHandle = document.querySelector("#receipt-fluid-resize-handle");
fluidResizeHandle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  fluidResizeStart = { x: event.clientX, width: fluidPreviewWidth };
  fluidResizeHandle.setPointerCapture(event.pointerId);
});
fluidResizeHandle.addEventListener("pointermove", (event) => {
  if (!fluidResizeStart || !fluidResizeHandle.hasPointerCapture(event.pointerId)) return;
  updateFluidPreview(fluidResizeStart.width + event.clientX - fluidResizeStart.x);
});
fluidResizeHandle.addEventListener("pointerup", (event) => {
  if (fluidResizeHandle.hasPointerCapture(event.pointerId)) fluidResizeHandle.releasePointerCapture(event.pointerId);
  fluidResizeStart = null;
});
fluidResizeHandle.addEventListener("pointercancel", () => { fluidResizeStart = null; });
fluidResizeHandle.addEventListener("keydown", (event) => {
  const increments = { ArrowLeft: -10, ArrowDown: -10, ArrowRight: 10, ArrowUp: 10 };
  if (event.key in increments) {
    event.preventDefault();
    updateFluidPreview(fluidPreviewWidth + increments[event.key]);
  } else if (event.key === "Home") {
    event.preventDefault();
    updateFluidPreview(120);
  } else if (event.key === "End") {
    event.preventDefault();
    updateFluidPreview(getFluidPreviewMaxWidth());
  }
});

document.querySelector("#domain-scan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await scanPageForCloudinaryUrls(document.querySelector("#domain-url").value);
  } catch (error) {
    setDomainScanStatus(error.message || "Enter a valid public webpage URL.", "error");
  }
});

document.querySelector("#clear-domain-scan").addEventListener("click", () => {
  domainScanRun += 1;
  domainScanController?.abort();
  domainScanController = null;
  const button = document.querySelector("#domain-scan-button");
  button.disabled = false;
  button.textContent = "Scan page";
  clearDomainScanResults({ clearInput: true });
  document.querySelector("#domain-url").focus();
});

document.querySelector("#domain-scan-limit").addEventListener("change", () => {
  if (!domainScanPageUrl) return;
  domainScanPage = 1;
  renderDomainScanPage();
});

document.querySelector("#domain-scan-order").addEventListener("change", () => {
  if (!domainScanPageUrl) return;
  domainScanPage = 1;
  renderDomainScanPage();
});

document.querySelector("#domain-scan-previous").addEventListener("click", () => {
  if (domainScanPage <= 1) return;
  domainScanPage -= 1;
  renderDomainScanPage();
});

document.querySelector("#domain-scan-next").addEventListener("click", () => {
  const limit = Number(document.querySelector("#domain-scan-limit").value) || DOMAIN_SCAN_DEFAULT_LIMIT;
  const totalPages = Math.max(1, Math.ceil(domainScanCandidates.length / limit));
  if (domainScanPage >= totalPages) return;
  domainScanPage += 1;
  renderDomainScanPage();
});

document.querySelector("#domain-scan-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-analyze-url]");
  if (!button) return;
  const candidate = domainScanCandidates.find((item) => item.url === button.dataset.analyzeUrl);
  activeScanAnalysisContext = {
    fromScan: true,
    sourcePageUrl: button.dataset.sourcePageUrl || domainScanPageUrl?.href || "",
    layout: candidate?.layout || null,
    clientSideHelper: candidate?.clientSideHelper || {
      status: "unknown",
      evidence: "The scan did not return client-side helper evidence."
    }
  };
  const inspectorResult = document.querySelector("#inspector-result");
  inspectorResult.hidden = false;
  analyzeAssetUrl(button.dataset.analyzeUrl, { ...activeScanAnalysisContext });
  setDomainScanStatus("The selected image is loaded in the optimizer below.", "success");
  inspectorResult.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
});

document.querySelector("#refresh-metrics").addEventListener("click", () => {
  refreshExpectedAssetForDevice();
  measureAll();
});
window.addEventListener("resize", () => {
  updateDeviceReadout();
  window.clearTimeout(window.__dprResizeTimer);
  window.__dprResizeTimer = window.setTimeout(() => {
    refreshExpectedAssetForDevice();
    measureAll();
    if (activeReceiptKey === "fluid") updateFluidPreview(fluidPreviewWidth);
  }, 120);
});

watchDeviceDprChanges();
updateDeviceReadout();
const defaultParsed = parseCloudinaryUrl(DEFAULT_ASSET_URL);
updateDemoAssets(defaultParsed, null, buildAudit(defaultParsed));
measureAll();
  
