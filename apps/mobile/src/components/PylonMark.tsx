import { useId } from "react";
import type { ColorValue } from "react-native";
import Svg, { Defs, Mask, Path } from "react-native-svg";

const HEX_PATH =
  "M558 158.6 L795.1 295.4 A92 92 0 0 1 841.1 375.1 L841.1 648.9 A92 92 0 0 1 795.1 728.6 L558 865.4 A92 92 0 0 1 466 865.4 L228.9 728.6 A92 92 0 0 1 182.9 648.9 L182.9 375.1 A92 92 0 0 1 228.9 295.4 L466 158.6 A92 92 0 0 1 558 158.6 Z";

const CUBE_PATH =
  "M321.5 395 L512 285 L702.5 395 M321.5 395 L512 505 L702.5 395 M702.5 395 L702.5 615 L512 725 M321.5 395 L321.5 892 M512 505 L512 892";

/** The monochrome Pylon mark, sized for native navigation and home headers. */
export function PylonMark(props: { readonly height: number; readonly color: ColorValue }) {
  const maskId = useId();

  return (
    <Svg
      accessibilityLabel="Pylon"
      height={props.height}
      width={props.height}
      viewBox="0 0 1024 1024"
    >
      <Defs>
        <Mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={1024} height={1024}>
          <Path d={HEX_PATH} fill="white" />
          <Path
            d={CUBE_PATH}
            fill="none"
            stroke="black"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={41}
          />
        </Mask>
      </Defs>
      <Path d={HEX_PATH} fill={props.color} mask={`url(#${maskId})`} />
    </Svg>
  );
}
