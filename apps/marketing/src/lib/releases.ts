const REPO = "pylon-code/pylon-releases";

export const REPOSITORY_URL = `https://github.com/${REPO}`;

export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

// Only plain stable X.Y.Z tags are marked as the repository's latest release;
// nightlies are always prereleases and are excluded here. Callers fall back to
// RELEASES_URL when this 404s, which it does until the first stable tag.
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "pylon-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
