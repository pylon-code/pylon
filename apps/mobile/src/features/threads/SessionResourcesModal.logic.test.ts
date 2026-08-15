import { describe, expect, it } from "vite-plus/test";

import { buildSessionResourceSections } from "./SessionResourcesModal.logic";

describe("buildSessionResourceSections", () => {
  it("keeps advertised empty categories and projects every bounded row", () => {
    const skills = Array.from({ length: 512 }, (_, index) => ({
      name: `skill-${index}`,
      description: index === 0 ? "Project-authored metadata" : undefined,
      scope: index === 0 ? ("project" as const) : undefined,
    }));
    const sections = buildSessionResourceSections({
      skills,
      prompts: [],
      showSkills: true,
      showPrompts: true,
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ title: "Skills · 512" });
    expect(sections[0]?.data).toHaveLength(512);
    expect(sections[0]?.data[0]).toMatchObject({
      name: "skill-0",
      description: "Project-authored metadata",
      scope: "project",
    });
    expect(sections[1]).toEqual({
      title: "Prompts · 0",
      emptyLabel: "No prompts available for this session.",
      data: [],
    });
  });

  it("omits resource categories the provider did not advertise", () => {
    expect(
      buildSessionResourceSections({
        skills: [],
        prompts: [{ name: "release", argumentHint: "<version>", scope: "user" }],
        showSkills: false,
        showPrompts: true,
      }),
    ).toEqual([
      {
        title: "Prompts · 1",
        emptyLabel: "No prompts available for this session.",
        data: [
          {
            key: "prompt:release:0",
            name: "release",
            argumentHint: "<version>",
            scope: "user",
          },
        ],
      },
    ]);
  });
});
