import type { FollowUpAvailability } from "~/state/followups";

export type FollowUpsRoutePresentation =
  | { readonly kind: "content" }
  | { readonly kind: "redirect" }
  | { readonly kind: "status"; readonly message: string };

export function resolveFollowUpsRoutePresentation(
  availability: FollowUpAvailability,
): FollowUpsRoutePresentation {
  if (availability.status === "available") return { kind: "content" };
  if (availability.status === "unavailable") return { kind: "redirect" };

  switch (availability.reason) {
    case "catalog":
    case "server-config":
      return { kind: "status", message: "Loading Follow-ups…" };
    case "connecting":
      return { kind: "status", message: "Connecting to Follow-ups…" };
    case "reconnecting":
      return { kind: "status", message: "Reconnecting to Follow-ups…" };
    case "offline":
      return {
        kind: "status",
        message:
          "Follow-ups are unavailable while offline. They’ll return when your connection recovers.",
      };
  }
}
