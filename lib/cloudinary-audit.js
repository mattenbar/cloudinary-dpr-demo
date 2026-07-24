/**
 * Pure Cloudinary delivery URL parsing and DPR audit helpers.
 * Safe to import from Node tests or a browser module script.
 */

export const formatDimensions = (width, height) => `${Math.round(width)} × ${Math.round(height)}`;

export const getRoundedDeviceDpr = (devicePixelRatio = globalThis.devicePixelRatio) =>
  Math.max(1, Math.ceil(devicePixelRatio || 1));

export const getClientHintSetup = (origin) => ({
  meta: `<meta http-equiv="delegate-ch" content="sec-ch-dpr ${origin}; sec-ch-width ${origin}; sec-ch-viewport-width ${origin};">`,
  headers: `Permissions-Policy: ch-dpr=("${origin}"), ch-width=("${origin}"), ch-viewport-width=("${origin}")\nAccept-CH: Sec-CH-DPR, Sec-CH-Width, Sec-CH-Viewport-Width`
});

const TRANSFORMATION_KEYS = new Set([
  "a", "ac", "af", "ar", "b", "bo", "br", "c", "co", "cs", "d", "dl", "dn", "dpr",
  "du", "e", "eo", "f", "fl", "fn", "fps", "g", "h", "if", "ki", "l", "o", "p",
  "pg", "q", "r", "so", "sp", "t", "u", "vc", "vs", "w", "x", "y", "z"
]);

export const looksLikeTransformationSegment = (segment) => {
  if (/^s--.+--$/.test(segment)) return true;
  return segment.split(",").every((token) => {
    if (!token || token.startsWith("$")) return true;
    const separator = token.indexOf("_");
    return separator > 0 && TRANSFORMATION_KEYS.has(token.slice(0, separator).toLowerCase());
  });
};

export const parseCloudinaryUrl = (rawValue) => {
  let url;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new Error("Enter a complete URL beginning with https://.");
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Only HTTP or HTTPS delivery URLs can be inspected.");
  }

  const marker = url.pathname.match(/\/(image|video)\/upload\//);
  if (!marker || marker.index === undefined) {
    throw new Error("This does not look like a Cloudinary /image/upload/ delivery URL.");
  }

  const markerEnd = marker.index + marker[0].length;
  const base = `${url.origin}${url.pathname.slice(0, markerEnd)}`;
  const tail = url.pathname.slice(markerEnd);
  const segments = tail.split("/").filter(Boolean);
  const versionIndex = segments.findIndex((segment) => /^v\d+$/.test(segment));
  let transformationSegments;
  let assetSegments;

  if (versionIndex >= 0) {
    transformationSegments = segments.slice(0, versionIndex);
    assetSegments = segments.slice(versionIndex);
  } else {
    let transformEnd = 0;
    while (transformEnd < segments.length && looksLikeTransformationSegment(segments[transformEnd])) {
      transformEnd += 1;
    }
    transformationSegments = segments.slice(0, transformEnd);
    assetSegments = segments.slice(transformEnd);
  }

  if (!assetSegments.length) {
    throw new Error("The URL is missing a public ID after the upload transformations.");
  }

  const tokens = transformationSegments.flatMap((segment) => segment.split(",").filter(Boolean));
  return {
    raw: url.href,
    url,
    base,
    resourceType: marker[1],
    transformationSegments,
    assetSegments,
    tokens,
    suffix: url.search
  };
};

export const isFormatAuto = (token) => /^f_auto(?:$|:)/.test(token);
export const isQualityAuto = (token) => /^q_auto(?:$|:)/.test(token);
export const isDprToken = (token) => /^dpr_/.test(token);
export const isWidthAutoToken = (token) => /^w_auto(?:$|:)/.test(token);
export const isHeightAutoToken = (token) => /^h_auto(?:$|:)/.test(token);
export const isNumericWidthToken = (token) => /^w_\d+(?:\.\d+)?$/.test(token);
export const isNumericHeightToken = (token) => /^h_\d+(?:\.\d+)?$/.test(token);

export const normalizeOptimizationOrder = (segments) => {
  const cleaned = segments
    .map((segment) => segment
      .split(",")
      .filter((token) => !isFormatAuto(token) && !isQualityAuto(token))
      .join(","))
    .filter(Boolean);
  return [...cleaned, "f_auto", "q_auto"];
};

export const replaceTransformationToken = (segments, matcher, replacement) => segments.map((segment) =>
  segment.split(",").map((token) => matcher.test(token) ? replacement : token).join(",")
);

export const replaceLastTransformationToken = (segments, predicate, replacement) => {
  const updated = [...segments];
  for (let segmentIndex = updated.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const tokens = updated[segmentIndex].split(",");
    for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
      if (!predicate(tokens[tokenIndex])) continue;
      tokens[tokenIndex] = replacement;
      updated[segmentIndex] = tokens.filter(Boolean).join(",");
      return updated.filter(Boolean);
    }
  }
  return updated;
};

export const buildDeliveryUrl = (parsed, segments) =>
  `${parsed.base}${[...segments, ...parsed.assetSegments].join("/")}${parsed.suffix}`;

export const getNumericToken = (tokens, key) => {
  const numericToken = new RegExp(`^${key}_\\d+(?:\\.\\d+)?$`);
  const token = [...tokens].reverse().find((candidate) => numericToken.test(candidate));
  const value = token?.slice(key.length + 1);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export const getAutoWidthInfo = (tokens) => {
  const token = [...tokens].reverse().find(isWidthAutoToken) || "";
  if (!token) return { token: "", fallback: 0 };
  const parameters = token.split(":").slice(1);
  const usesBreakpoints = parameters[0]?.startsWith("breakpoints");
  const fallbackCandidate = usesBreakpoints
    ? parameters.length > 1 ? parameters.at(-1) : ""
    : parameters.length > 1 ? parameters[1] : "";
  const fallback = Number(fallbackCandidate);
  return { token, fallback: Number.isFinite(fallback) ? fallback : 0 };
};

export const getDprInfo = (tokens) => {
  const token = [...tokens].reverse().find(isDprToken);
  if (!token) return { token: "", label: "Omitted (1×)", value: 1, isAuto: false, isExplicit: false };
  const rawValue = token.slice(4);
  if (rawValue === "auto") return { token, label: "dpr_auto", value: 0, isAuto: true, isExplicit: false };
  const value = Number(rawValue);
  return {
    token,
    label: Number.isFinite(value) ? `${value}× fixed` : token,
    value: Number.isFinite(value) ? value : 0,
    isAuto: false,
    isExplicit: Number.isFinite(value)
  };
};

export const getAspectRatioValue = (tokens) => {
  const token = [...tokens].reverse().find((candidate) => /^ar_\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?$/.test(candidate));
  if (!token) return 0;
  const rawValue = token.slice(3);
  if (rawValue.includes(":")) {
    const [width, height] = rawValue.split(":").map(Number);
    return width > 0 && height > 0 ? width / height : 0;
  }
  const ratio = Number(rawValue);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
};

export const getFilenameDimensions = (assetSegments) => {
  const filename = assetSegments.at(-1) || "";
  const match = filename.match(/_(\d+)x(\d+)(?=\.[^./]+$)/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

export const parsePositivePixelValue = (rawValue) => {
  const match = String(rawValue || "").trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const getSizesPixelFallback = (sizes) => {
  const matches = [...String(sizes || "").matchAll(/(?:^|[\s,])(\d+(?:\.\d+)?)px(?=\s*(?:,|$))/gi)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const buildScrapedLayoutContext = (url, elementContext = null) => {
  try {
    const parsed = parseCloudinaryUrl(url);
    const width = getNumericToken(parsed.tokens, "w");
    const height = getNumericToken(parsed.tokens, "h");
    const autoWidth = getAutoWidthInfo(parsed.tokens);
    const dpr = getDprInfo(parsed.tokens);
    const filenameDimensions = getFilenameDimensions(parsed.assetSegments);
    const widthAttribute = parsePositivePixelValue(elementContext?.widthAttribute);
    const heightAttribute = parsePositivePixelValue(elementContext?.heightAttribute);
    const styleWidth = parsePositivePixelValue(elementContext?.styleWidth);
    const styleHeight = parsePositivePixelValue(elementContext?.styleHeight);
    const styleMaxWidth = parsePositivePixelValue(elementContext?.styleMaxWidth);
    const sizesWidth = getSizesPixelFallback(elementContext?.sizes);
    const filenameMatchesDpr = filenameDimensions && width && dpr.isExplicit && dpr.value > 1
      && Math.abs(width - filenameDimensions.width * dpr.value) < .01;
    let displayWidth = 0;
    let displayHeight = 0;
    let source = "";
    let confidence = "inferred";

    if (widthAttribute || heightAttribute) {
      displayWidth = widthAttribute;
      displayHeight = heightAttribute;
      source = "HTML width/height attributes";
      confidence = "declared";
    } else if (styleWidth || styleHeight || styleMaxWidth) {
      displayWidth = styleWidth || styleMaxWidth;
      displayHeight = styleHeight;
      source = "inline page CSS";
      confidence = "declared";
    } else if (sizesWidth) {
      displayWidth = sizesWidth;
      source = "HTML sizes fallback";
      confidence = "declared";
    } else if (filenameMatchesDpr) {
      displayWidth = filenameDimensions.width;
      displayHeight = filenameDimensions.height;
      source = "asset dimensions matched to the page’s DPR transform";
    } else if (autoWidth.fallback) {
      displayWidth = autoWidth.fallback;
      source = "w_auto fallback in the page URL";
      confidence = "URL-derived";
    } else if (width || height) {
      displayWidth = width;
      displayHeight = height;
      source = "Cloudinary sizing transform used by the page";
      confidence = "URL-derived";
    } else if (filenameDimensions) {
      displayWidth = filenameDimensions.width;
      displayHeight = filenameDimensions.height;
      source = "asset filename dimensions";
    }

    const styleAspectRatio = String(elementContext?.styleAspectRatio || "").replace(/\s*\/\s*/, ":");
    const inlineAspectRatio = styleAspectRatio
      ? getAspectRatioValue([`ar_${styleAspectRatio}`])
      : 0;
    const aspectRatio = displayWidth && displayHeight
      ? displayWidth / displayHeight
      : inlineAspectRatio
        || getAspectRatioValue(parsed.tokens)
        || (filenameDimensions ? filenameDimensions.width / filenameDimensions.height : 0)
        || (width && height ? width / height : 0);
    if (!displayHeight && displayWidth && aspectRatio) displayHeight = displayWidth / aspectRatio;
    if (!displayWidth && displayHeight && aspectRatio) displayWidth = displayHeight * aspectRatio;

    const layoutSignals = [
      elementContext?.sizes,
      elementContext?.styleWidth,
      elementContext?.styleMaxWidth,
      elementContext?.className,
      elementContext?.ancestorClasses
    ].filter(Boolean).join(" ");
    const fluid = /(?:^|[\s:;])(w-full|max-w-full|h-auto|flex-1|grid|flex-row|col-span)|100%|\d+vw|calc\(/i.test(layoutSignals);
    const dimensions = displayWidth && displayHeight
      ? formatDimensions(displayWidth, displayHeight)
      : displayWidth
        ? `${Math.round(displayWidth)} px wide`
        : displayHeight
          ? `${Math.round(displayHeight)} px high`
          : "Dimensions unavailable";
    const columnCount = Number(elementContext?.layoutColumnCount) || 0;
    const breakpointPixels = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };
    const breakpoint = elementContext?.layoutBreakpoint || "";
    const layoutKind = fluid
      ? columnCount > 1 ? `Fluid/responsive ${columnCount}-column page slot` : "Fluid/responsive page slot"
      : "Fixed page slot";
    const suggestedSizes = elementContext?.sizes
      || (fluid && displayWidth
        ? breakpoint && breakpointPixels[breakpoint]
          ? `(max-width: ${breakpointPixels[breakpoint] - 1}px) 100vw, ${Math.round(displayWidth)}px`
          : `(max-width: ${Math.round(displayWidth)}px) 100vw, ${Math.round(displayWidth)}px`
        : "");

    return {
      displayWidth: displayWidth ? Math.round(displayWidth) : 0,
      displayHeight: displayHeight ? Math.round(displayHeight) : 0,
      fluid,
      layoutKind,
      source: source || "No page sizing metadata found",
      confidence,
      sizes: elementContext?.sizes || "",
      suggestedSizes,
      columnCount,
      breakpoint,
      pageIndex: elementContext?.pageIndex ?? -1,
      description: `${layoutKind} · ${dimensions} · ${confidence}: ${source || "no reliable sizing metadata"}`
    };
  } catch {
    return {
      displayWidth: 0,
      displayHeight: 0,
      fluid: false,
      layoutKind: "Page layout unavailable",
      source: "The page sizing metadata could not be parsed",
      confidence: "unavailable",
      sizes: "",
      suggestedSizes: "",
      columnCount: 0,
      breakpoint: "",
      pageIndex: elementContext?.pageIndex ?? -1,
      description: "Page layout unavailable · dimensions could not be inferred"
    };
  }
};

export const greatestCommonDivisor = (first, second) => {
  let a = Math.abs(Math.round(first));
  let b = Math.abs(Math.round(second));
  while (b) [a, b] = [b, a % b];
  return a || 1;
};

export const buildResponsiveWidthSegments = (segments, tokens, width, height) => {
  const numericWidths = tokens.filter(isNumericWidthToken);
  const numericHeights = tokens.filter(isNumericHeightToken);
  const hasLayers = tokens.some((token) => /^[lu]_/.test(token) || token === "fl_layer_apply");
  const alreadyAutomatic = tokens.some(isWidthAutoToken);
  const hasInvalidAutoHeight = tokens.some(isHeightAutoToken);
  if (!width || numericWidths.length !== 1 || numericHeights.length > 1 || hasLayers || alreadyAutomatic || hasInvalidAutoHeight) return [];

  const sizingComponentIndex = segments.findIndex((segment) => {
    const componentTokens = segment.split(",");
    return componentTokens.some(isNumericWidthToken) || componentTokens.some(isNumericHeightToken);
  });
  if (sizingComponentIndex < 0) return [];

  const sizingTokens = segments[sizingComponentIndex].split(",");
  const resizeToken = sizingTokens.find((token) => /^c_/.test(token));
  const fillToken = sizingTokens.find((token) => token === "c_fill");
  if (height && !fillToken) return [];
  if (!height && resizeToken && !/^c_(?:scale|fit|limit)$/.test(resizeToken)) return [];

  const divisor = height ? greatestCommonDivisor(width, height) : 1;
  const aspectRatio = height ? `ar_${Math.round(width / divisor)}:${Math.round(height / divisor)}` : "";
  const cleaned = segments
    .slice(0, -2)
    .map((segment, index) => {
      let componentTokens = segment
        .split(",")
        .filter((token) => !isNumericWidthToken(token) && !isNumericHeightToken(token) && !isDprToken(token));

      if (index === sizingComponentIndex) {
        if (aspectRatio) {
          componentTokens.push(aspectRatio);
        } else {
          componentTokens = componentTokens.filter((token) =>
            !/^c_(?:scale|fit|limit)$/.test(token) && !/^g_/.test(token)
          );
        }
      }
      return componentTokens.join(",");
    })
    .filter(Boolean);

  return [...cleaned, `c_limit,w_auto:40:${Math.round(width)},dpr_auto`, "f_auto", "q_auto"];
};

export const orderAuditIssues = (issues) => {
  const severityOrder = { error: 0, warning: 1, info: 2, success: 3 };
  return [...issues].sort((first, second) =>
    (severityOrder[first.severity] ?? 4) - (severityOrder[second.severity] ?? 4)
  );
};

export const buildAudit = (parsed, scanContext = null) => {
  const issues = [];
  const { transformationSegments: segments, tokens } = parsed;
  const hasFormatAuto = tokens.some(isFormatAuto);
  const hasQualityAuto = tokens.some(isQualityAuto);
  const correctlyOrdered = segments.length >= 2
    && segments.at(-2) === "f_auto"
    && segments.at(-1) === "q_auto";
  const width = getNumericToken(tokens, "w");
  const height = getNumericToken(tokens, "h");
  const autoWidth = getAutoWidthInfo(tokens);
  const hasHeightAuto = tokens.some(isHeightAutoToken);
  const hasDeliveryDimension = Boolean(width || height || autoWidth.token);
  const dpr = getDprInfo(tokens);
  const filenameDimensions = getFilenameDimensions(parsed.assetSegments);
  const hasSignature = segments.some((segment) => /^s--.+--$/.test(segment));
  const correctedSegments = normalizeOptimizationOrder(segments);
  const correctedUrl = buildDeliveryUrl(parsed, correctedSegments);

  if (!hasFormatAuto || !hasQualityAuto) {
    issues.push({
      severity: "warning",
      title: "Automatic optimization is incomplete",
      text: `Add ${!hasFormatAuto ? "f_auto" : ""}${!hasFormatAuto && !hasQualityAuto ? " and " : ""}${!hasQualityAuto ? "q_auto" : ""} to negotiate an efficient format and quality level.`
    });
  }

  if ((hasFormatAuto || hasQualityAuto) && !correctlyOrdered) {
    issues.push({
      severity: "error",
      title: "Optimization transformations are in the wrong position",
      text: "Keep format and quality out of mixed transformation components. They should be the final two components in this exact order: /f_auto/q_auto."
    });
  } else if (correctlyOrdered) {
    issues.push({
      severity: "success",
      title: "Optimization order is correct",
      text: "Automatic format and quality are the final chained transformations."
    });
  }

  if (hasHeightAuto) {
    issues.push({
      severity: "error",
      title: "h_auto is not a supported delivery transformation",
      text: "Use w_auto for responsive delivery width and establish height with the source aspect ratio or an ar_ crop. CSS height: auto controls browser layout, not the Cloudinary transformation."
    });
  }

  if (!hasDeliveryDimension) {
    issues.push({
      severity: "warning",
      title: "No delivery dimensions are set",
      text: "Without w_, h_, or w_auto, the URL can deliver the full-size original. Add the intended logical display dimensions before choosing DPR."
    });
  }

  if (dpr.token && !hasDeliveryDimension) {
    issues.push({
      severity: "error",
      title: "DPR has no resize dimension",
      text: "A DPR transformation must be paired with a width or height transformation."
    });
  }

  if (autoWidth.token) {
    issues.push({
      severity: "info",
      title: "Automatic width requires accurate sizes markup",
      text: "Add a sizes attribute that matches the image’s real CSS layout so the browser can send Sec-CH-Width. Keep width and height attributes to reserve the correct aspect ratio."
    });
    if (!autoWidth.fallback) {
      issues.push({
        severity: "warning",
        title: "Automatic width has no fallback",
        text: "Without a width hint, bare w_auto can deliver the original dimensions. Add a rounding step and fallback such as w_auto:40:360."
      });
    }
  } else if (width && !hasHeightAuto) {
    issues.push({
      severity: "info",
      title: "A fluid slot can use automatic width",
      text: `If this image changes width with the layout, consider c_limit,w_auto:40:${Math.round(width)},dpr_auto plus an accurate sizes attribute. Keep w_${width} when the slot is always fixed.`
    });
  }

  if (dpr.isExplicit && dpr.value > 1) {
    issues.push({
      severity: "warning",
      title: "Matching HTML dimensions are required",
      text: `This URL requests ${dpr.value}× output. Set the image tag to the logical dimensions—not the multiplied output dimensions—to prevent the browser from displaying it too large.`
    });
    issues.push({
      severity: "info",
      title: "A fixed DPR is sent to every device",
      text: "For browser delivery, consider dpr_auto so 1× devices do not download a hard-coded high-density asset."
    });
  } else if (dpr.isAuto) {
    issues.push({
      severity: "info",
      title: "Automatic DPR needs client hints",
      text: "The requesting page must delegate Sec-CH-DPR to this delivery origin. Unsupported contexts receive Cloudinary’s 1× fallback."
    });
  } else if (!dpr.token) {
    issues.push({
      severity: "info",
      title: "DPR is omitted",
      text: "This forces 1× delivery. That is efficient on standard-density screens but can look soft on high-density displays."
    });
  }

  if (scanContext?.fromScan && (dpr.isExplicit || dpr.isAuto)) {
    const origin = parsed.url.origin;
    const sourcePage = scanContext.sourcePageUrl || "the scanned page";
    const setup = getClientHintSetup(origin);
    const isDelegatedByLab = origin === "https://res.cloudinary.com";
    issues.push({
      severity: isDelegatedByLab ? "info" : "warning",
      title: isDelegatedByLab
        ? "Verify DPR delegation on the scanned page"
        : "Scraped custom delivery host needs explicit DPR delegation",
      text: isDelegatedByLab
        ? `${sourcePage} must delegate Sec-CH-DPR to ${origin} for dpr_auto to match the device.`
        : `This asset uses ${origin}, which was discovered after this lab document loaded. The lab cannot retroactively delegate client hints to it, so its dpr_auto measurement can fall back to 1×. Configure the scanned page to delegate Sec-CH-DPR to this exact origin.`,
      suggestion: setup.meta
    });
  }

  if (scanContext?.fromScan) {
    const helper = scanContext.clientSideHelper || { status: "unknown", evidence: "" };
    issues.push({
      severity: helper.status === "detected"
        ? "success"
        : helper.status === "missing"
          ? "warning"
          : "info",
      title: helper.status === "detected"
        ? "Client-side helper: detected"
        : helper.status === "missing"
          ? "Client-side helper: missing"
          : "Client-side helper: could not verify",
      text: helper.status === "detected"
        ? `${helper.evidence} Client-hint delegation must still be configured separately for dpr_auto.`
        : helper.status === "missing"
          ? `${helper.evidence} Add and initialize the Cloudinary client-side helper if this page relies on responsive client-side URL updates. Client-hint delegation for dpr_auto is a separate requirement.`
          : `${helper.evidence} Check the delivered page source or application bundle before relying on client-side responsive URL updates.`
    });
  }

  if (filenameDimensions && width && dpr.isExplicit && dpr.value > 1
      && Math.abs(width - filenameDimensions.width * dpr.value) < .01) {
    const suggestedSegments = replaceTransformationToken(
      correctedSegments,
      /^w_/,
      `w_${filenameDimensions.width}`
    );
    issues.push({
      severity: "error",
      title: "Possible double DPR calculation",
      text: `The filename suggests a ${filenameDimensions.width} × ${filenameDimensions.height} display, but w_${width} is already ${dpr.value}× wider and dpr_${dpr.value} multiplies it again. If ${filenameDimensions.width}px is the intended CSS width, use w_${filenameDimensions.width} with matching HTML dimensions.`,
      suggestion: buildDeliveryUrl(parsed, suggestedSegments)
    });
  }

  if (hasSignature) {
    issues.push({
      severity: "warning",
      title: "Signed URL must be regenerated",
      text: "Changing transformations invalidates the existing signature. Generate a new signed URL for either recommendation."
    });
  }

  const responsiveSegments = dpr.isExplicit
    ? replaceTransformationToken(correctedSegments, /^dpr_/, "dpr_auto")
    : [];
  const responsiveWidthSegments = buildResponsiveWidthSegments(correctedSegments, tokens, width, height);

  return {
    issues: orderAuditIssues(issues),
    width,
    height,
    autoWidth,
    dpr,
    correctedUrl,
    responsiveUrl: responsiveSegments.length ? buildDeliveryUrl(parsed, responsiveSegments) : "",
    responsiveWidthUrl: responsiveWidthSegments.length ? buildDeliveryUrl(parsed, responsiveWidthSegments) : ""
  };
};

export const buildAutomaticDprSimulation = (parsed, audit, layoutContext = null, options = {}) => {
  const automaticUrl = audit.dpr.isExplicit
    ? audit.responsiveUrl
    : audit.dpr.isAuto ? audit.correctedUrl : "";
  if (!automaticUrl) return null;

  const devicePixelRatio = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
  const targetDpr = getRoundedDeviceDpr(devicePixelRatio);
  const automaticParsed = parseCloudinaryUrl(automaticUrl);
  const automaticWidth = Boolean(audit.autoWidth.token);
  const pageWidth = layoutContext?.displayWidth || 0;
  const pageHeight = layoutContext?.displayHeight || 0;
  let logicalWidth = pageWidth || (automaticWidth ? audit.autoWidth.fallback : audit.width);
  let logicalHeight = pageHeight || audit.height;
  const aspectRatio = getAspectRatioValue(automaticParsed.tokens);

  if (!automaticWidth && !logicalWidth && logicalHeight && aspectRatio) logicalWidth = logicalHeight * aspectRatio;
  if (!logicalHeight && logicalWidth && aspectRatio) logicalHeight = logicalWidth / aspectRatio;

  let productionSegments = [...automaticParsed.transformationSegments];
  if (pageWidth && !automaticWidth) {
    productionSegments = replaceLastTransformationToken(
      productionSegments,
      isNumericWidthToken,
      `w_${Math.round(pageWidth)}`
    );
  }
  if (pageHeight && audit.height) {
    productionSegments = replaceLastTransformationToken(
      productionSegments,
      isNumericHeightToken,
      `h_${Math.round(pageHeight)}`
    );
  }

  let foundDpr = false;
  const resolvedSegments = productionSegments
    .map((segment) => segment
      .split(",")
      .map((token) => {
        if (isDprToken(token)) {
          foundDpr = true;
          return targetDpr === 1 ? "" : `dpr_${targetDpr.toFixed(1)}`;
        }
        if (isWidthAutoToken(token) && logicalWidth) return `w_${Math.round(logicalWidth)}`;
        return token;
      })
      .filter(Boolean)
      .join(","))
    .filter(Boolean);

  if (!foundDpr) return null;

  const projectedWidth = logicalWidth ? logicalWidth * targetDpr : 0;
  const projectedHeight = logicalHeight ? logicalHeight * targetDpr : 0;
  const projectedLabel = projectedWidth && projectedHeight
    ? formatDimensions(projectedWidth, projectedHeight)
    : projectedWidth
      ? `${Math.round(projectedWidth)} px wide`
      : projectedHeight
        ? `${Math.round(projectedHeight)} px high`
        : "Depends on the page’s CSS slot";
  const layoutDimensions = logicalWidth && logicalHeight
    ? formatDimensions(logicalWidth, logicalHeight)
    : logicalWidth
      ? `${Math.round(logicalWidth)} px wide`
      : logicalHeight
        ? `${Math.round(logicalHeight)} px high`
        : "Dimensions unavailable";
  const sizingBasis = layoutContext?.source && (pageWidth || pageHeight)
    ? `${layoutDimensions} · ${layoutContext.source}`
    : automaticWidth
      ? logicalWidth ? `${Math.round(logicalWidth)} px w_auto fallback` : "CSS slot width unavailable"
      : logicalWidth && logicalHeight
        ? formatDimensions(logicalWidth, logicalHeight)
        : logicalWidth
          ? `${Math.round(logicalWidth)} px logical width`
          : logicalHeight
            ? `${Math.round(logicalHeight)} px logical height`
            : "No delivery dimensions";
  const isSigned = parsed.transformationSegments.some((segment) => /^s--.+--$/.test(segment));
  const hasSizingBasis = Boolean(logicalWidth || logicalHeight);

  return {
    targetDpr,
    deviceDpr: devicePixelRatio || 1,
    url: buildDeliveryUrl(automaticParsed, resolvedSegments),
    productionUrl: buildDeliveryUrl(automaticParsed, productionSegments),
    projectedLabel,
    sizingBasis,
    logicalWidth: logicalWidth ? Math.round(logicalWidth) : 0,
    logicalHeight: logicalHeight ? Math.round(logicalHeight) : 0,
    layoutContext,
    canPreview: hasSizingBasis && !isSigned,
    isSigned,
    usedWidthFallback: automaticWidth && !pageWidth && Boolean(logicalWidth),
    usedPageLayout: Boolean((pageWidth || pageHeight) && layoutContext)
  };
};

/**
 * @param {string} url
 * @param {object|null} layoutContext
 * @param {{ devicePixelRatio?: number }} [options]
 */
export const getScannedUrlRecommendation = (url, layoutContext = null, options = {}) => {
  try {
    const parsed = parseCloudinaryUrl(url);
    if (!parsed.tokens.some(isDprToken)) return null;
    const audit = buildAudit(parsed);
    const errorCount = audit.issues.filter((issue) => issue.severity === "error").length;
    const warningCount = audit.issues.filter((issue) => issue.severity === "warning").length;
    const actionableIssue = audit.issues.find((issue) => issue.severity === "error")
      || audit.issues.find((issue) => issue.severity === "warning");
    const customOriginSetup = audit.dpr.isAuto && parsed.url.origin !== "https://res.cloudinary.com";
    const automaticSimulation = buildAutomaticDprSimulation(parsed, audit, layoutContext, options);
    const title = actionableIssue?.title
      || (audit.responsiveUrl ? "Automatic DPR alternative available" : "")
      || (audit.responsiveWidthUrl ? "Responsive-width alternative available" : "")
      || (customOriginSetup ? "Verify client-hint delegation for custom origin" : "");
    if (!title) return null;

    const score = Math.min(100, Math.max(10,
      errorCount * 30
      + warningCount * 20
      + (audit.responsiveUrl ? 10 : 0)
      + (audit.responsiveWidthUrl ? 10 : 0)
      + (customOriginSetup ? 10 : 0)
    ));
    const opportunityCount = Number(Boolean(audit.responsiveUrl))
      + Number(Boolean(audit.responsiveWidthUrl))
      + Number(customOriginSetup);

    return {
      title,
      dprLabel: audit.dpr.label,
      score,
      errorCount,
      warningCount,
      opportunityCount,
      automaticSimulation
    };
  } catch {
    return null;
  }
};
