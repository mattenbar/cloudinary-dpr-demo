/**
 * Pure ranking helpers for the performance receipt.
 */

export const RECEIPT_LABELS = {
  original: "Original source",
  baseline: "Fixed 1×",
  fixed: "Hard-coded 2×",
  auto: "Automatic DPR",
  autoExpected: "Expected automatic output",
  fluid: "Fluid automatic width + DPR"
};

export const RECEIPT_SETTINGS = {
  original: "No transformations",
  baseline: "DPR omitted",
  fixed: "dpr_2.0",
  auto: "dpr_auto",
  autoExpected: "Resolved device DPR diagnostic",
  fluid: "w_auto + dpr_auto"
};

/**
 * @param {Map|Record<string, {bytes?: number, transferBytes?: number}>} metrics
 * @param {string[]} receiptKeys
 */
export const selectSmallestTransfers = (metrics, receiptKeys = ["original", "baseline", "fixed", "auto"]) => {
  const get = (key) => (typeof metrics.get === "function" ? metrics.get(key) : metrics[key]);
  const measuredReceipts = receiptKeys.map((key) => ({ key, measurement: get(key) }));
  const hasCompleteNetworkTransfers = measuredReceipts.every((candidate) => candidate.measurement?.transferBytes > 0);
  const bandwidthAvailable = measuredReceipts
    .map(({ key, measurement }) => {
      const comparisonBytes = hasCompleteNetworkTransfers ? measurement?.transferBytes : measurement?.bytes;
      return comparisonBytes > 0 ? { key, measurement, comparisonBytes } : null;
    })
    .filter(Boolean);

  if (!bandwidthAvailable.length) {
    return {
      hasCompleteNetworkTransfers,
      smallestBytes: 0,
      keys: [],
      labels: []
    };
  }

  const smallestBytes = Math.min(...bandwidthAvailable.map((candidate) => candidate.comparisonBytes));
  const smallestTransfers = bandwidthAvailable.filter((candidate) => candidate.comparisonBytes === smallestBytes);
  return {
    hasCompleteNetworkTransfers,
    smallestBytes,
    keys: smallestTransfers.map((candidate) => candidate.key),
    labels: smallestTransfers.map((candidate) => RECEIPT_LABELS[candidate.key])
  };
};

/**
 * Pick the device recommendation among fixed-size strategies.
 * @param {Map|Record<string, {bytes?: number, naturalWidth?: number}>} metrics
 * @param {{ targetDpr: number, baseWidth?: number, strategyKeys?: string[] }} options
 */
export const selectDeviceRecommendation = (
  metrics,
  { targetDpr, baseWidth = 360, strategyKeys = ["baseline", "fixed", "auto"] } = {}
) => {
  const get = (key) => (typeof metrics.get === "function" ? metrics.get(key) : metrics[key]);
  const recommendationAvailable = strategyKeys
    .map((key) => {
      const measurement = get(key);
      return measurement?.bytes > 0
        ? { key, measurement, deliveredDpr: measurement.naturalWidth / baseWidth }
        : null;
    })
    .filter(Boolean);

  if (!recommendationAvailable.length) {
    return {
      selectedKey: "auto",
      qualified: false,
      automaticMissedTarget: false,
      autoDeliveredDpr: 0,
      selected: null
    };
  }

  const qualified = recommendationAvailable.filter((candidate) => candidate.deliveredDpr + 0.05 >= targetDpr);
  const pool = qualified.length ? [...qualified] : [...recommendationAvailable];
  pool.sort((first, second) => {
    if (!qualified.length && Math.abs(first.deliveredDpr - second.deliveredDpr) > 0.05) {
      return second.deliveredDpr - first.deliveredDpr;
    }
    if (first.measurement.bytes !== second.measurement.bytes) {
      return first.measurement.bytes - second.measurement.bytes;
    }
    return first.key === "auto" ? -1 : second.key === "auto" ? 1 : 0;
  });

  const selected = pool[0];
  const autoMeasurement = get("auto");
  const autoDeliveredDpr = autoMeasurement?.naturalWidth ? autoMeasurement.naturalWidth / baseWidth : 0;
  const automaticMissedTarget = targetDpr > 1 && autoDeliveredDpr > 0 && autoDeliveredDpr + 0.05 < targetDpr;

  return {
    selectedKey: selected.key,
    selected,
    qualified: qualified.length > 0,
    automaticMissedTarget,
    autoDeliveredDpr
  };
};

/**
 * Copy for the device-recommendation verdict when live dpr_auto meets (or misses) the target.
 * @param {boolean} qualified
 * @param {number} targetDpr
 */
export const buildDeviceRecommendationReason = (qualified, targetDpr) =>
  qualified
    ? `It is the smallest measured response that meets this browser’s rounded ${targetDpr}× DPR target.`
    : `No measured strategy reached this browser’s rounded ${targetDpr}× DPR target, so this is the highest-density measured option with the fewest bytes.`;
