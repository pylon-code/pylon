import { describe, expect, it } from "vite-plus/test";
import { projectTitleInitial } from "./projectTitleInitial";

describe("projectTitleInitial", () => {
  it.each([
    ["Pylon", "P"],
    [" 3D Studio", "3"],
    ["🌈 café", "C"],
    ["  Журнал", "Ж"],
    ["   ", "P"],
    ["", "P"],
  ])("uses the first title letter for %s", (title, initial) => {
    expect(projectTitleInitial(title)).toBe(initial);
  });
});
