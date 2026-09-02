import { useId, type SVGProps } from "react";

const PYLON_HEX_PATH =
  "M558 158.6 L795.1 295.4 A92 92 0 0 1 841.1 375.1 L841.1 648.9 A92 92 0 0 1 795.1 728.6 L558 865.4 A92 92 0 0 1 466 865.4 L228.9 728.6 A92 92 0 0 1 182.9 648.9 L182.9 375.1 A92 92 0 0 1 228.9 295.4 L466 158.6 A92 92 0 0 1 558 158.6 Z";

const PYLON_CUBE_PATH =
  "M321.5 395 L512 285 L702.5 395 M321.5 395 L512 505 L702.5 395 M702.5 395 L702.5 615 L512 725 M321.5 395 L321.5 892 M512 505 L512 892";

export function PylonMark(props: SVGProps<SVGSVGElement>) {
  const maskId = useId();

  return (
    <svg
      {...props}
      aria-hidden="true"
      className={props.className ?? "size-5 shrink-0"}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask id={maskId}>
        <path d={PYLON_HEX_PATH} fill="white" />
        <path
          d={PYLON_CUBE_PATH}
          fill="none"
          stroke="black"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="41"
        />
      </mask>
      <path d={PYLON_HEX_PATH} fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
