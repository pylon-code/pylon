# Pylon brand icons

The Pylon fork keeps its logo sources as vectors:

- `prod/logo.svg` is the canonical black/off-white application icon.
- `dev/app-icon.icon/Assets/text.svg`, `nightly/app-icon.icon/Assets/text.svg`, and `prod/app-icon.icon/Assets/text.svg` contain the monochrome Pylon mark.
- The development and preview `background.svg` files preserve their channel-specific artwork behind the Pylon mark.
- `apps/mobile/assets/widget/T3Mark.svg` is the template-rendered widget mark. Its legacy filename is retained because the native widget asset pipeline already references it.
  It is also the source for the two generated Android renditions: `android-icon-mark.png`, which fills its canvas for the monochrome themed icon, and `android-icon-foreground.png`, which is inset into Android’s adaptive safe zone so the launcher mask cannot clip the mark.

Run `vp run icons:export` from the repository root to regenerate the tracked mobile, desktop, web, and marketing assets. Run `vp run icons:check` to verify that those generated files match their sources without changing files.

The exporter is `scripts/export-pylon-brand-icons.mjs`. It uses Sharp for PNG and WebP renditions, the repository's ICO encoder for Windows icons, and `iconutil` on macOS for the desktop ICNS. On Windows and Linux, it leaves the tracked ICNS unchanged while generating and checking every portable asset.

macOS PNGs use the classic 824×824 icon body centered inside a transparent 1024×1024 canvas. Generated PNG, WebP, ICO, and ICNS files should not be edited directly.

The original T3 Code Icon Composer exporter remains available as `vp run icons:export:t3` for upstream comparison; it is not the Pylon branding source of truth.
