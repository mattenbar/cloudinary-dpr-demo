# Cloudinary DPR Lab

A dependency-free HTML demo that makes the difference between incorrect DPR markup, correct fixed DPR markup, and `dpr_auto` visible and measurable. It uses the SpaceX image from the `doxfstysv` cloud as its default comparison asset. There is no bundler: the page loads relative CSS and JS, and pure URL parsing/audit logic lives in `lib/cloudinary-audit.js`.

## Project layout

| Path | Role |
| --- | --- |
| `index.html` | Markup only |
| `styles.css` | Page styles |
| `app.js` | UI wiring, measurements, dialogs |
| `lib/cloudinary-audit.js` | Testable URL parse + DPR audit |
| `lib/scanner.js` | Page URL validation, extraction, candidate ordering |
| `lib/measurements.js` | Resource Timing helpers + byte formatters |
| `lib/receipt.js` | Smallest-transfer / device-recommendation ranking |
| `lib/fluid-urls.js` | `w_auto` / `dpr_auto` URL builders |
| `lib/deep-links.js` | `?asset=` / `?scan=` query helpers |
| `lib/browser.js` | Shared browser capability checks |
| `test/` | Node tests for the pure modules |

## Open the demo

Serve the folder over HTTP (required for ES module imports and for live `dpr_auto` client hints):

```bash
npm run serve
```

Then open [http://localhost:8080](http://localhost:8080). An internet connection is still required for the Cloudinary images and documentation links.

### Demo tips

- Prefer **HTTPS** or **localhost**. Opening via `file://` will not load the ES modules in modern browsers, and even if served locally a `file://` page cannot delegate `Sec-CH-DPR`, so live `dpr_auto` shows Cloudinary’s documented 1× fallback.
- Paste a delivery URL in section 01, or use the sample chips, without scanning a page first.
- Shareable links: `?asset=<cloudinary-url>` opens the inspector; `?scan=<page-url>` prefills and runs the page scanner.
- Sample scan targets in the UI hit Cloudinary documentation pages. Results depend on what those pages currently publish; the scanner may return zero DPR candidates if none are present.
- Page scans send the target URL to [Jina Reader](https://github.com/jina-ai/reader). Rate limits and blocked pages are possible; wait and retry on HTTP 429.
- The same relative asset paths work on GitHub Pages or any static HTTPS host.

Browser security prevents a `file://` page from delegating the `Sec-CH-DPR` client hint, so the live `dpr_auto` example intentionally reports Cloudinary's documented 1× fallback when hints are unavailable. To demonstrate live server-side DPR matching, use HTTPS (or localhost) with the lab’s `delegate-ch` meta tag.

## Audit module tests

The URL parser and DPR audit logic live in [`lib/cloudinary-audit.js`](lib/cloudinary-audit.js) so they can be exercised without the browser UI:

```bash
npm test
```

## Page scanner

Enter one public webpage URL to scan that page for Cloudinary `/image/upload/` delivery URLs. Results are limited to URLs that contain a `dpr_` transformation and for which the audit finds an actionable issue or can generate an automatic-DPR or responsive-width alternative. Already-optimized DPR URLs with no recommendation and URLs without DPR are omitted. The scanner does not crawl the rest of the domain, follow links, or inspect a sitemap. Results are deduplicated and paginated, with 5 results shown by default and options for 10, 25, or 50 per page. Every visible result immediately loads a thumbnail using the exact scanned delivery URL without changing its transformations; CSS alone fits the image into the compact preview. A failed thumbnail request is retried twice with the same URL before being marked unavailable. Each result has an **Analyze** action that loads the URL into the optimizer.

Every candidate receives an **Optimization potential** percentage. Errors contribute 30 percentage points, warnings 20 points, and generated automatic-DPR, fluid-width, or custom-origin setup opportunities contribute 10 points each, capped at 100%. Results default to highest potential first with original page position as the stable tie breaker. They can also be ordered by lowest potential, page top-to-bottom, or page bottom-to-top; every result retains its original `Found #` position when sorted.

Because browsers normally block direct cross-origin page scraping, the page content is retrieved through the public [Jina Reader](https://github.com/jina-ai/reader) service. A fast metadata pass first resolves redirects and canonical metadata, then the scanner explains that it is rendering the canonical page and waiting for lazy-loaded images. The full scan requests a fresh browser-rendered, unfiltered page snapshot with a complete image summary. This keeps apex and `www` forms from producing different stale or lightweight snapshots while making the extra render time visible to the user. Private and local network addresses are rejected, and some public pages may still block automated reading or trigger the reader's rate limit.

Every scraped candidate identifies its exact image delivery origin and clearly reports whether a known Cloudinary client-side helper script or initialization call was detected, missing, or could not be verified from the retrieved source HTML. Custom delivery hostnames are flagged because `Sec-CH-DPR` must be delegated to that origin for `dpr_auto` to match the device. Selecting **Analyze** is the only way to open the asset audit: it carries the scanned page context into the optimizer and generates copyable `delegate-ch`, `Permissions-Policy`, and `Accept-CH` setup. Actionable findings are ordered by severity, with errors before warnings and informational guidance. A newly discovered custom origin cannot be added retroactively to the already-loaded lab document, so its live `dpr_auto` comparison may show the 1× fallback even though the production page will adapt correctly after the generated setup is applied.

Scanner results also show the expected automatic DPR for the current device. A parallel source-HTML pass matches each discovered URL back to its `<img>` element and records declared `width`, `height`, `sizes`, inline sizing, responsive classes, and multi-column ancestors. The sizing resolver prefers declared page data, then strong inferences such as filename dimensions that match the existing DPR transform, followed by `w_auto` fallback or Cloudinary sizing tokens. Each result states which source was used rather than silently substituting the lab’s 360 × 240 slot. Selecting **Analyze** loads a deterministic equivalent that resolves `dpr_auto` to the browser’s rounded DPR, then reports the projected and actual response dimensions and derived file size. This explicit URL is diagnostic only; production markup retains `dpr_auto`, the page-layout sizing, and generated client-hint delegation.

## Asset optimizer

Paste a standard Cloudinary `/image/upload/` delivery URL, or select one discovered by the page scanner, to:

- Preview the URL's current output.
- Read its delivered physical dimensions and transferred bytes.
- Detect missing or misplaced `f_auto` and `q_auto`.
- Flag a DPR transformation without dimensions, required HTML display dimensions, hard-coded DPR, and likely double DPR calculations.
- Generate a format-corrected URL that preserves other transformations.
- Generate a `dpr_auto` alternative when the inspected URL has a fixed DPR.
- Recommend a `w_auto` plus `dpr_auto` alternative for simple fluid-width transformations, including a fallback width and matching `sizes` markup.
- Flag unsupported `h_auto`, bare `w_auto` without a fallback, and `w_auto` markup that still needs an accurate `sizes` attribute.
- Generate matching `<img>` display markup.
- Compare the untransformed original SpaceX file size with the correctly optimized 1× delivery.
- Reuse the inspected asset across the comparison cards. Section 02 loads the exact scanned delivery URL, measures its delivered response dimensions, and uses the scanned page’s declared or inferred slot dimensions for its displayed-size and effective-DPR values. When the page exposes no usable slot dimensions, the section labels its 360 × 240 benchmark as a fallback rather than scanned data.

Automatic optimization components are always normalized to the end of the transformation path:

```text
<other transformations>/f_auto/q_auto
```

## Performance receipt

The receipt separates two decisions. **Smallest transfer** identifies the lowest measured network transfer, including response overhead, when all strategies expose transfer measurements; if cache or browser restrictions hide any transfer, it falls back to encoded file size for a fair comparison. **Recommended for this device** identifies the smallest measured strategy that meets the current browser's rounded DPR target; if none reaches that target, it chooses the highest-density available response with the fewest bytes. If `dpr_auto` misses the target while a hard-coded DPR reaches it, the hard-coded result is labeled **Best measured fallback**, not the production recommendation, and the automatic row explains whether HTTPS, browser support, or client-hint delegation is missing. When one strategy is both the smallest transfer and device recommendation, its two badges stack vertically to keep the strategy column compact. The desktop receipt uses a wrapping fixed table, then becomes complete strategy cards at narrower widths so all eight fields remain visible without horizontal scrolling.

The receipt keeps the fixed strategies as a 360 × 240 comparison benchmark and adds a separate **Expected with setup** row. For a scraped asset, that row uses the matched page slot and responsive layout context, resolves the current browser’s rounded DPR to an explicit diagnostic transformation, and measures its delivered dimensions, displayed dimensions, file size, bandwidth, and original-file delta. Its popup shows the deterministic preview URL, the production `dpr_auto` URL, layout-matched markup, and copyable `delegate-ch` or HTTP header setup. The live automatic row can therefore continue to report that its hint was missing without hiding the output expected after setup.

The receipt includes a full fluid-layout strategy row using `w_auto:40:360`, `dpr_auto`, and matching `sizes`, width, height, and fluid CSS markup. It reports the same delivered dimensions, displayed dimensions, file size, bandwidth, comparison, and **Inspect** action as every other strategy. It is clearly badged as production layout guidance and excluded from smallest-transfer/device ranking because its responsive-width request is not directly comparable with the fixed 360 × 240 benchmark. Its popup uses the fluid URL as the optimal URL and repeats the complete fluid markup.

The fluid popup includes a draggable resize handle and an accessible width slider that can expand the preview up to 720 CSS pixels when the viewport has room. It shows the live CSS slot, the 40-pixel `w_auto` selection, the browser's rounded `dpr_auto` value, target physical pixels, actual response dimensions, derived file size, transfer bandwidth, and a concrete diagnostic URL representing those automatic choices. The production `w_auto` fallback and matching HTML markup update with the selected slot size while the explicit resolved URL remains diagnostic. The full-width preview sits above the information panel so the slot has maximum horizontal room; the lower details panel scrolls independently, with safe bottom padding on desktop and mobile so the preview stays in place and the final content is fully reachable.

## What the demo proves

- A `w_360,h_240,dpr_2.0` URL produces a 720 × 480 resource.
- Without matching HTML dimensions, that 2× resource displays at its 720 × 480 natural size.
- With `width="360" height="240"`, the same resource displays correctly at 360 × 240 CSS pixels.
- `dpr_auto` uses the delegated `Sec-CH-DPR` client hint in supported Chromium browsers and falls back to 1× when the hint is unavailable.
- `w_auto` can adapt a fluid image to its available layout width when `Sec-CH-Width` and an accurate `sizes` attribute are available.
- A URL such as `w_auto:40:360` limits derived-width variation to 40-pixel steps and supplies a 360-pixel fallback when the width hint is unavailable.
- Cloudinary does not support `h_auto` as an automatic-height transformation; use an aspect ratio for delivery and CSS `height: auto` for fluid browser layout.

The page holds `f_auto` and `q_auto` constant across the performance comparison so that DPR is the changing variable.
