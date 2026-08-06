import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // This site is inherited from upstream and still carries T3's product copy
  // and legal pages. Deploying it under Pylon would publish another company's
  // terms, privacy policy, and security policy as if they governed this
  // product. Git deployments stay off until the content is rewritten — see
  // docs/operations/marketing-and-legal.md.
  git: {
    deploymentEnabled: false,
  },
};
