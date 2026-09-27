/** A stable first visible letter for Lucide icons, which mobile cannot render. */
export function projectTitleInitial(title: string): string {
  const normalized = title.normalize("NFKC");
  return (normalized.match(/[\p{L}\p{N}]/u)?.[0] ?? "P").toUpperCase();
}
