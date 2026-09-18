import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // Vercel builds this project on every push to every branch, and almost none of
  // those pushes touch the site: on a busy day that is over a hundred builds and
  // the account's build rate limit, which then fails unrelated pull requests and
  // stalls the hosted app's release deploy. Exit 0 skips the build, anything
  // else builds. The diff is against the branch's last deployed commit; when
  // that commit is not in Vercel's shallow clone git fails, which builds.
  ignoreCommand:
    'git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}" HEAD -- . ../../packages/shared ../../pnpm-lock.yaml ../../pnpm-workspace.yaml',
  redirects: [{ source: "/app", destination: "https://app.pylon-code.com", permanent: true }],
  // Deployments were held off while this site still carried T3's product copy
  // and legal pages. Those pages are gone — Pylon publishes no terms, privacy,
  // or security policy — and the remaining copy is Pylon's own. See
  // docs/operations/marketing-and-legal.md before adding any legal page back.
  git: {
    deploymentEnabled: true,
  },
};
