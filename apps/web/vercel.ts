import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

// Pylon's own hosted origins. These drive the channel routing rules, so they
// must agree with the domains the release workflow aliases each deployment to
// (T3CODE_WEB_ROUTER_URL, T3CODE_WEB_LATEST_DOMAIN, T3CODE_WEB_NIGHTLY_DOMAIN)
// — a mismatch leaves the router matching a host it never serves, and the
// channel switch silently stops working. Kept flat rather than nested under
// the router host so every name stays one label deep.
const ROUTER_HOST = "app.pylon-code.com";
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = "https://latest.pylon-code.com";
const NIGHTLY_ORIGIN = "https://nightly.pylon-code.com";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
