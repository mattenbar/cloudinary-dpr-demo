# Cloudinary DPR Lab

A dependency-free HTML demo that makes the difference between incorrect DPR markup, correct fixed DPR markup, and `dpr_auto` visible and measurable. It uses the SpaceX image from the `doxfstysv` cloud as its default comparison asset.

## Open the demo

Double-click `index.html` or drag it into a browser. The CSS and JavaScript are embedded in that one file, so there is no build step, dependency install, or terminal command. An internet connection is still required for the Cloudinary images and documentation links.

The explicit DPR comparisons, URL inspector, corrections, and performance readouts all work from the local file. Browser security prevents a `file://` page from delegating the `Sec-CH-DPR` client hint, so the live `dpr_auto` example intentionally reports Cloudinary's documented 1× fallback in local-file mode. To demonstrate live server-side DPR matching, place this same self-contained file on an HTTPS static host (or serve it from localhost).

## URL inspector

Paste a standard Cloudinary `/image/upload/` delivery URL into the inspector to:

- Preview the URL's current output.
- Read its delivered physical dimensions and transferred bytes.
- Detect missing or misplaced `f_auto` and `q_auto`.
- Flag a DPR transformation without dimensions, required HTML display dimensions, hard-coded DPR, and likely double DPR calculations.
- Generate a format-corrected URL that preserves other transformations.
- Generate a `dpr_auto` alternative when the inspected URL has a fixed DPR.
- Generate matching `<img>` display markup.

Automatic optimization components are always normalized to the end of the transformation path:

```text
<other transformations>/f_auto/q_auto
```

## What the demo proves

- A `w_360,h_240,dpr_2.0` URL produces a 720 × 480 resource.
- Without matching HTML dimensions, that 2× resource displays at its 720 × 480 natural size.
- With `width="360" height="240"`, the same resource displays correctly at 360 × 240 CSS pixels.
- `dpr_auto` uses the delegated `Sec-CH-DPR` client hint in supported Chromium browsers and falls back to 1× when the hint is unavailable.

The page holds `f_auto` and `q_auto` constant across the performance comparison so that DPR is the changing variable.
