/**
 * Fluid w_auto / dpr_auto URL and markup helpers.
 */

import {
  parseCloudinaryUrl,
  replaceTransformationToken,
  buildDeliveryUrl
} from "./cloudinary-audit.js";

export const BASE_WIDTH = 360;
export const BASE_HEIGHT = 240;

export const roundFluidWidth = (width) => Math.max(40, Math.ceil(width / 40) * 40);

export const buildFluidMarkup = (url, width = BASE_WIDTH) => {
  const cssWidth = Math.max(1, Math.round(width));
  const cssHeight = Math.round(cssWidth * BASE_HEIGHT / BASE_WIDTH);
  return `<img src="${url}" sizes="(max-width: ${cssWidth}px) 100vw, ${cssWidth}px" width="${cssWidth}" height="${cssHeight}" style="width:100%;max-width:${cssWidth}px;height:auto" alt="">`;
};

export const buildResolvedFluidPreviewUrl = (url, width, dpr) => {
  const parsed = parseCloudinaryUrl(url);
  let segments = replaceTransformationToken(parsed.transformationSegments, /^w_auto(?:$|:)/, `w_${width}`);
  segments = replaceTransformationToken(segments, /^dpr_auto$/, `dpr_${dpr.toFixed(1)}`);
  return buildDeliveryUrl(parsed, segments);
};

export const buildFluidAutomaticUrl = (url, fallbackWidth) => {
  const parsed = parseCloudinaryUrl(url);
  const segments = replaceTransformationToken(
    parsed.transformationSegments,
    /^w_auto(?:$|:)/,
    `w_auto:40:${fallbackWidth}`
  );
  return buildDeliveryUrl(parsed, segments);
};
