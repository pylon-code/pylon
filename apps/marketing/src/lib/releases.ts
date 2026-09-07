const REPO = "pylon-code/pylon-releases";

export const REPOSITORY_URL = `https://github.com/${REPO}`;

export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

// Only plain stable X.Y.Z tags are marked as the repository's latest release;
// nightlies are always prereleases and are excluded here. Callers fall back to
// RELEASES_URL when this 404s, which it does until the first stable tag.
const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

function isRelease(value: unknown): value is Release {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "html_url" in value &&
    typeof value.html_url === "string" &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset: unknown) =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        typeof asset.name === "string" &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string",
    )
  );
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = `pylon-${channel}-release`;
  try {
    const cached: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (isRelease(cached)) return cached;
  } catch {
    // Storage can be unavailable or contain stale data; release links still work.
  }

  const response = await fetch(channel === "nightly" ? LIST_API_URL : LATEST_API_URL);
  if (!response.ok) throw new Error(`Could not load ${channel} releases`);
  const data: unknown = await response.json();
  const release: unknown =
    channel === "nightly" && Array.isArray(data)
      ? data.find((item: unknown) => isRelease(item) && item.tag_name.includes("-nightly."))
      : data;
  if (!isRelease(release)) throw new Error(`No ${channel} release available`);

  try {
    sessionStorage.setItem(key, JSON.stringify(release));
  } catch {
    // Caching is optional, including in browsers that block session storage.
  }

  return release;
}
