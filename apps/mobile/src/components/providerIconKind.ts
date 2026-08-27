export type ProviderIconKind =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "omp"
  | "primeAgent"
  | "unknown";

export function providerIconKind(provider: string | null | undefined): ProviderIconKind {
  switch (provider) {
    case "claudeAgent":
      return "claude";
    case "codex":
    case "cursor":
    case "grok":
    case "opencode":
    case "omp":
    case "primeAgent":
      return provider;
    default:
      return "unknown";
  }
}
