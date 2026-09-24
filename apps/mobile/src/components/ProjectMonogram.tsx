import type { ProjectIconColor } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText } from "./AppText";

const backgroundClasses: Record<ProjectIconColor, string> = {
  gray: "bg-gray-500/15",
  red: "bg-red-500/15",
  orange: "bg-orange-500/15",
  amber: "bg-amber-500/15",
  yellow: "bg-yellow-500/15",
  lime: "bg-lime-500/15",
  green: "bg-green-500/15",
  emerald: "bg-emerald-500/15",
  teal: "bg-teal-500/15",
  cyan: "bg-cyan-500/15",
  sky: "bg-sky-500/15",
  blue: "bg-blue-500/15",
  indigo: "bg-indigo-500/15",
  violet: "bg-violet-500/15",
  purple: "bg-purple-500/15",
  fuchsia: "bg-fuchsia-500/15",
  pink: "bg-pink-500/15",
  rose: "bg-rose-500/15",
};

export function ProjectMonogram(props: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly size: number;
}) {
  return (
    <View
      accessibilityLabel={`${props.text} project monogram`}
      className={`items-center justify-center ${backgroundClasses[props.color]}`}
      style={{ width: props.size, height: props.size, borderRadius: props.size * 0.25 }}
    >
      <AppText className="font-t3-bold" style={{ fontSize: props.size * 0.5 }} numberOfLines={1}>
        {props.text}
      </AppText>
    </View>
  );
}
