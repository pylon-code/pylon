import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectSourceScreen } from "./AddProjectScreen";

type AddProjectSourceRouteParams = {
  /** The machine to start on; New project passes the one it had selected. */
  readonly environmentId?: string | string[];
};

export function AddProjectSourceRoute({
  route,
}: StaticScreenProps<AddProjectSourceRouteParams | undefined>) {
  return <AddProjectSourceScreen {...(route.params ?? {})} />;
}
