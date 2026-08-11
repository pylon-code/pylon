# Static Jcode Provider Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary Jcode terminal glyph with the approved static coarse-halftone adaptation across web, desktop-wrapped web, and mobile.

**Architecture:** Define one immutable 24×24 dot geometry in `@t3tools/client-runtime`, then render it with native SVG primitives in each client. Existing provider routing remains unchanged, desktop inherits web, and no asset-generation pipeline is involved.

**Tech Stack:** TypeScript, React SVG, React Native SVG, Vite Plus tests and typechecks.

## Global Constraints

- Preserve the approved Option B coarse-halftone treatment.
- Use no animation, filters, masks, or raster assets.
- Keep the mark theme-aware and monochrome.
- Do not change compatibility identifiers or Pylon application icons.
- Verify only affected packages and representative clients, not the repository-wide suite.

---

### Task 1: Shared static mark geometry and client renderers

**Files:**

- Create: `packages/client-runtime/src/presentation/providerMarks.ts`
- Create: `packages/client-runtime/src/presentation/providerMarks.test.ts`
- Modify: `packages/client-runtime/package.json`
- Modify: `apps/web/src/components/Icons.tsx:690-712`
- Modify: `apps/web/src/components/chat/providerIconUtils.test.ts:24-46`
- Modify: `apps/mobile/src/components/ProviderIcon.tsx:1-108`
- Modify: `apps/mobile/src/components/providerIconKind.test.ts:21-23`

**Interfaces:**

- Produces: `JCODE_MARK_VIEW_BOX: "0 0 24 24"`.
- Produces: `JCODE_MARK_DOTS: ReadonlyArray<readonly [cx: number, cy: number, radius: number, opacity: number]>`.
- Consumes: the existing `JcodeIcon` and `providerIconKind("jcode")` routing paths.

- [ ] **Step 1: Add failing shared-geometry and routing assertions**

Create `providerMarks.test.ts` asserting that the exported geometry exists, contains the expected fixed number of dots, remains inside the 24×24 canvas, has a clear central aperture, and contains multiple opacity/radius levels. Rename the existing web and mobile test descriptions from “terminal mark” to “static halftone mark”.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
vp test run \
  packages/client-runtime/src/presentation/providerMarks.test.ts \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/mobile/src/components/providerIconKind.test.ts
```

Expected: the new shared geometry test fails because the module and exports do not exist.

- [ ] **Step 3: Implement the shared geometry**

Create a fixed base lobe made from two tapered rows of circles. Rotate that lobe by 0°, 120°, and 240° around `(12, 12)` at module initialization to produce the immutable coarse-halftone swirl. Export only the final view box and dot tuples through a new `./presentation/provider-marks` package subpath.

- [ ] **Step 4: Replace both terminal renderers**

In web, map `JCODE_MARK_DOTS` to `<circle>` elements using `fill="currentColor"` and per-dot opacity. In mobile, map the same tuples to React Native SVG `<Circle>` elements using the existing theme-aware `mono` color. Remove the now-unused mobile `Rect` import and replace comments that describe a terminal glyph.

- [ ] **Step 5: Run focused GREEN checks**

Run:

```bash
vp test run \
  packages/client-runtime/src/presentation/providerMarks.test.ts \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/mobile/src/components/providerIconKind.test.ts
vp run -F @t3tools/client-runtime typecheck
vp run -F @t3tools/web typecheck
vp run -F @t3tools/mobile typecheck
```

Expected: all focused tests and three typechecks pass.

- [ ] **Step 6: Inspect static renditions and integrated clients**

Render the shared geometry at 16px, 20px, and 64px in light and dark monochrome, then inspect the running web provider picker/settings surface and one mobile provider surface. Confirm the central aperture remains open, the three lobes remain readable, and no animation or repaint loop exists.

- [ ] **Step 7: Commit**

```bash
git add \
  docs/superpowers/specs/2026-08-11-jcode-provider-mark-design.md \
  docs/superpowers/plans/2026-08-11-jcode-provider-mark.md \
  packages/client-runtime/package.json \
  packages/client-runtime/src/presentation/providerMarks.ts \
  packages/client-runtime/src/presentation/providerMarks.test.ts \
  apps/web/src/components/Icons.tsx \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/mobile/src/components/ProviderIcon.tsx \
  apps/mobile/src/components/providerIconKind.test.ts
git commit -m "feat(clients): use the Jcode halftone mark"
```
