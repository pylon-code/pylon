import { getProviderUnavailablePresentation } from "@t3tools/client-runtime/providerAvailability";
import type { ServerProvider } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export function ProviderUnavailableNotice(props: {
  readonly provider: ServerProvider | null | undefined;
  readonly reason?: string | null;
  readonly title?: string;
}) {
  const presentation = getProviderUnavailablePresentation(props.provider);
  const detail = props.reason?.trim() || presentation?.detail;
  if (!detail) return null;

  const providerName = props.provider?.displayName?.trim() || "Provider";
  const title = props.title ?? `${providerName} is unavailable`;

  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      className="mb-2 gap-1 rounded-2xl border border-red-500/30 bg-red-500/10 px-3.5 py-3"
    >
      <Text className="text-sm font-t3-bold text-foreground">{title}</Text>
      <Text className="text-sm leading-snug text-foreground-muted">{detail}</Text>
    </View>
  );
}
