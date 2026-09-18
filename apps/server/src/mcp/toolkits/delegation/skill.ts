// @effect-diagnostics nodeBuiltinImport:off - Static build asset loading, outside the Effect service runtime.
import * as NodeFS from "node:fs";

// Embed the canonical repo skill in releases: installed servers cannot depend
// on a source checkout. Direct TypeScript development reads the same source.
declare const __PYLON_DELEGATION_SKILL__: string | undefined;
export const delegationSkill =
  typeof __PYLON_DELEGATION_SKILL__ === "string"
    ? __PYLON_DELEGATION_SKILL__
    : NodeFS.readFileSync(
        new URL("../../../../../../.agents/skills/pylon-delegation/SKILL.md", import.meta.url),
        "utf8",
      );
