# Static Jcode Provider Mark Design

**Status:** Approved
**Decision:** Option B, a coarse halftone adaptation of Jcode's animated website mark.

## Goal

Replace Pylon's temporary Jcode terminal glyph with a static provider mark that remains recognizable at the 16–20px sizes used in provider pickers, settings, model controls, and sidebars.

## Visual treatment

- Reconstruct the asymmetrical three-lobed swirl on a 24×24 canvas.
- Preserve the website mark's dotted character with a limited set of larger circles rather than imperceptible micro-dots.
- Keep a clear central aperture and tapered lobe ends so the mark does not collapse into a generic dotted ring.
- Render as theme-aware monochrome: `currentColor` on web and the existing light/dark monochrome token on mobile.
- Use no animation, filters, masks, raster assets, or continuously repainting effects.

## Architecture

- Store the mark's dot geometry once in `@t3tools/client-runtime` as presentation-only data.
- Render that geometry with a web SVG component in `apps/web` and React Native SVG in `apps/mobile`.
- Keep the existing provider-to-icon routing intact so desktop inherits the web renderer automatically.
- Do not change Pylon application icons, Jcode runtime identifiers, compatibility names, or product typography.

## Verification

- Unit-test the shared geometry bounds and the existing provider icon routing.
- Run focused web, mobile, and client-runtime tests and typechecks.
- Inspect the mark at representative 16px and 20px sizes in light and dark themes.
- Verify the running web client and one mobile client surface because the user explicitly requested cross-client validation.

## Affected surfaces

- Web, local and hosted presentation code.
- Desktop, through the wrapped web client.
- Mobile, iOS and Android through the shared React Native component.
- Marketing and application/channel icons are not affected.
