import type { MenuAction } from "@react-native-menu/menu";

export function buildThreadAutoSettleMenuItems(input: {
  readonly supported: boolean;
  readonly autoSettleDisabledAt: string | null | undefined;
}): MenuAction[] {
  if (!input.supported) return [];

  return [
    {
      id: "auto-settle",
      title: "Auto-settle behavior",
      image: "timer",
      subactions: [
        {
          id: "auto-settle:enabled",
          title: "Enabled",
          state: input.autoSettleDisabledAt == null ? "on" : "off",
        },
        {
          id: "auto-settle:disabled",
          title: "Disabled",
          state: input.autoSettleDisabledAt == null ? "off" : "on",
        },
      ],
    },
  ];
}
