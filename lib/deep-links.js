/** Shareable ?asset= / ?scan= query helpers for the DPR Lab. */

/** Decode a URI component without throwing on malformed escapes. */
export const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseLabQuery = (search = "") => {
  const raw = String(search || "");
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  return {
    asset: (params.get("asset") || "").trim(),
    scan: (params.get("scan") || "").trim()
  };
};

export const buildLabQuery = ({ asset = "", scan = "" } = {}) => {
  const params = new URLSearchParams();
  if (asset) params.set("asset", asset);
  if (scan) params.set("scan", scan);
  const query = params.toString();
  return query ? `?${query}` : "";
};

export const replaceLabQuery = (locationLike, { asset = "", scan = "" } = {}) => {
  const path = `${locationLike.pathname || "/"}${buildLabQuery({ asset, scan })}${locationLike.hash || ""}`;
  return path;
};
