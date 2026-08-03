---
name: pylon-branding
description: Maintain Pylon's visual identity across source vectors, generated app icons and favicons, in-product marks, wordmarks, and product-name copy. Use when changing Pylon logos, icons, branding, colors, typography, or visible naming; when validating branding across web, desktop, mobile, and marketing; or when an upstream merge may have restored T3 assets or copy.
---

# Pylon Branding

Keep brand changes source-driven and consistent across every affected surface. Separate visible Pylon identity from inherited compatibility identifiers so a cosmetic change cannot break runtime behavior.

## Establish the scope

- Read `AGENTS.md`, especially **Compatibility names** and **Hit every surface**.
- Treat `.t3`, `T3CODE_HOME`, `t3.json`, `npx t3`, `@t3tools/*`, `com.t3tools.*`, URL schemes, and legacy source filenames as compatibility identifiers. Do not rename them during visual-brand work unless the developer explicitly requests a coordinated migration.
- Keep typography, color, naming, and logo changes as separate decisions when the request limits scope. Do not change fonts merely because a logo or wordmark changes.
- Inspect the current diff before editing. Preserve unrelated upstream or user changes.

## Use the canonical sources

- Read `assets/README.md` for the current asset pipeline.
- Use `assets/prod/logo.svg` as the production application-icon source.
- Use the `text.svg` files under `assets/dev`, `assets/nightly`, and `assets/prod` for channel-specific monochrome marks.
- Preserve `apps/mobile/assets/widget/T3Mark.svg` as the compatibility-named widget source until the native asset pipeline is deliberately migrated.
- Locate code-rendered marks and wordmarks with `rg "PylonMark|T3Mark|logo\.svg|Pylon|T3 Code" apps packages`. Prefer one reusable vector component per client over copied path data.
- Treat `scripts/export-pylon-brand-icons.mjs` as the generated-asset manifest. Do not edit tracked PNG, WebP, ICO, or ICNS renditions by hand.

The original `icons:export:t3` task exists only for upstream comparison. It is not a Pylon source of truth.

## Apply a brand change

1. Inventory every affected entry point and client before editing.
2. Change the smallest vector or code source that owns the visual.
3. Preserve the SVG view box and optical padding unless the task specifically concerns sizing. Match visible silhouette size, not only CSS box size.
4. Run `vp run icons:export` when a source icon changes. On non-macOS hosts, leave the tracked ICNS unchanged as documented in `assets/README.md`.
5. Update visible product copy separately from compatibility identifiers.
6. Review the diff for accidental T3 asset restoration, unrelated typography changes, and duplicated vector data.

## Verify the result

- Run `vp run icons:check` after any icon-source or exporter change.
- Run formatter, lint, and typecheck only for affected packages and files. Do not run repository-wide checks unless asked.
- Inspect representative development and production renditions when generated assets change. Confirm transparency, padding, small-size legibility, and light/dark contrast.
- When the user requests browser or device verification, use `test-pylon-app` or `test-pylon-mobile` and verify one representative client after integration.
- Report which surfaces applied: web/local web, desktop, mobile iOS/Android, marketing, and channel variants.

Avoid continuously repainting logo effects or decorative animations. Branding must not compromise the product's performance.
