import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // Deployments were held off while this site still carried T3's product copy
  // and legal pages. Those pages are gone — Pylon publishes no terms, privacy,
  // or security policy — and the remaining copy is Pylon's own. See
  // docs/operations/marketing-and-legal.md before adding any legal page back.
  git: {
    deploymentEnabled: true,
  },
};
