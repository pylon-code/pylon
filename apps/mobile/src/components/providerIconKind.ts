export type ProviderIconKind =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
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
    case "primeAgent":
      return provider;
    default:
      return "unknown";
  }
}
