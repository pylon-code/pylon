import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import { SymbolView as ExpoSymbolView, type SymbolViewProps } from "expo-symbols";
import { withUniwind } from "uniwind";

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

/**
 * Use SF Symbols on iOS except for pull requests, which have no matching
 * native glyph. Import only that Tabler icon to keep the bundle small.
 */
function AppSymbolView(props: SymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : (props.name as { ios?: string })?.ios;
  if (name === "arrow.triangle.pull") {
    return (
      <IconGitPullRequest
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size}
        strokeWidth={2}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView {...props} />;
}

export const SymbolView = withUniwind(AppSymbolView);
