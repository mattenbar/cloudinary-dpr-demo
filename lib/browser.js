/** Shared browser capability checks. */

export const isChromiumBrowser = (userAgent = globalThis.navigator?.userAgent || "") =>
  /Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(userAgent) && !/Firefox|FxiOS/.test(userAgent);
