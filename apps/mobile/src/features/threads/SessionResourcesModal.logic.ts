import type { SessionResourceInventory } from "@t3tools/client-runtime/state/session-resources";

export type SessionResourceRow = {
  readonly key: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly scope?: "user" | "project" | "temporary" | undefined;
};

export type SessionResourceSection = {
  readonly title: string;
  readonly emptyLabel: string;
  readonly data: ReadonlyArray<SessionResourceRow>;
};

export function buildSessionResourceSections(
  inventory: SessionResourceInventory,
): ReadonlyArray<SessionResourceSection> {
  const sections: Array<SessionResourceSection> = [];
  if (inventory.showSkills) {
    sections.push({
      title: `Skills · ${inventory.skills.length}`,
      emptyLabel: "No skills available for this session.",
      data: inventory.skills.map((item, index) => ({
        ...item,
        key: `skill:${item.name}:${index}`,
      })),
    });
  }
  if (inventory.showPrompts) {
    sections.push({
      title: `Prompts · ${inventory.prompts.length}`,
      emptyLabel: "No prompts available for this session.",
      data: inventory.prompts.map((item, index) => ({
        ...item,
        key: `prompt:${item.name}:${index}`,
      })),
    });
  }
  return sections;
}
