/**
 * Resource Timing helpers and byte formatters for the performance receipt.
 */

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unavailable";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024;
    return `${kilobytes >= 100 ? Math.round(kilobytes) : kilobytes.toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const formatBandwidth = (measurement) => {
  if (!measurement) return "Unavailable";
  if (measurement.wasCached) return "Cached (0 B transfer)";
  if (measurement.transferBytes > 0) return formatBytes(measurement.transferBytes);
  return "Unavailable";
};

export const formatDelta = (bytes, originalBytes, isOriginal = false) => {
  if (isOriginal) return "Baseline";
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(originalBytes) || originalBytes <= 0) {
    return "—";
  }
  const delta = bytes - originalBytes;
  const percent = Math.round((delta / originalBytes) * 100);
  if (delta === 0) return "Same size";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatBytes(Math.abs(delta))} (${sign}${Math.abs(percent)}%)`;
};

export const imageReady = (image) => {
  if (!image) return Promise.resolve();
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
    if (image.complete) {
      const src = image.getAttribute("src");
      if (src) image.src = src;
      else resolve();
    }
  });
};

export const getResourceDetails = (url, performanceLike = globalThis.performance) => {
  const entries = typeof performanceLike?.getEntriesByName === "function"
    ? performanceLike.getEntriesByName(url)
    : [];
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
  const hasTimingBody = encodedBodySizes.length > 0;
  const bytes = hasTimingBody ? Math.max(...encodedBodySizes) : responseBytes;
  const transferBytes = transferSizes.length ? Math.max(...transferSizes) : 0;
  // Only treat as cached when Resource Timing exposed a body size with a zero transfer.
  // Cross-origin entries often report 0/0 while Cloudinary content-info still supplies bytes.
  const wasCached = hasTimingBody && transferBytes === 0;

  return {
    bytes,
    transferBytes,
    wasCached,
    width,
    height
  };
};
