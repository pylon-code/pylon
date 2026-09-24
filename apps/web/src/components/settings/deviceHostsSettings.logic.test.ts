import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { planDeviceHostUpdates, updateDeviceHosts } from "./deviceHostsSettings.logic";

describe("device hosts in selected environments", () => {
  const host = { id: "primary", label: "Mac", target: "dev@mac" };
  const sibling = { id: "sibling", label: "Android", target: "dev@android" };

  it("adds to independent lists without replacing unrelated hosts and is retry-safe", () => {
    const lists = [[], [sibling], [host, sibling]].map((hosts) =>
      updateDeviceHosts(hosts, host, null, false, true),
    );
    expect(lists).toEqual([[host], [sibling, host], [host, sibling]]);
    expect(lists.map((hosts) => updateDeviceHosts(hosts, host, null, false, true))).toEqual(lists);
  });

  it("edits and removes a uniquely matching destination with a different environment ID", () => {
    const remote = { ...host, id: "remote", identityFile: "/remote/key" };
    const edited = { ...host, label: "Renamed", target: "dev@new-mac" };
    expect(updateDeviceHosts([sibling, remote], edited, host, false, false)).toEqual([
      sibling,
      { ...edited, id: "remote", identityFile: "/remote/key" },
    ]);
    expect(
      updateDeviceHosts(
        [{ ...edited, id: "remote", identityFile: "/remote/key" }],
        edited,
        host,
        false,
        false,
      ),
    ).toEqual([{ ...edited, id: "remote", identityFile: "/remote/key" }]);
    expect(updateDeviceHosts([sibling, remote], host, host, true, true)).toEqual([sibling]);
  });

  it("preserves target-local identity paths unless the editor explicitly changes them", () => {
    const representative = { ...host, identityFile: "/primary/key" };
    const remote = { ...host, id: "remote", identityFile: "/remote/key" };
    expect(updateDeviceHosts([], representative, null, false, false)).toEqual([host]);
    expect(updateDeviceHosts([remote], representative, host, false, false)).toEqual([remote]);
    expect(updateDeviceHosts([host], representative, host, false, false)).toEqual([host]);
    expect(updateDeviceHosts([remote], representative, host, false, true)).toEqual([
      { ...representative, id: "remote" },
    ]);
  });

  it("fails closed on ambiguous destinations or a conflicting ID", () => {
    const ambiguous = [host, { ...host, id: "other" }];
    expect(() => updateDeviceHosts(ambiguous, host, host, true, true)).toThrow("Multiple");
    const unrelated = { ...sibling, id: host.id };
    expect(() => updateDeviceHosts([unrelated], host, null, false, true)).toThrow("ID");
    const edited = { ...host, label: "Renamed", target: "dev@new-mac", identityFile: "/new/key" };
    const conflict = { ...edited, id: "remote", identityFile: "/someone-else/key" };
    expect(() => updateDeviceHosts([conflict], edited, host, false, true)).toThrow("destination");
  });

  it("plans local, remote, and mixed selections without replacing local paths or hiding offline targets", () => {
    const primary = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const offline = EnvironmentId.make("offline");
    const original = { ...host, identityFile: "/local/key" };
    const changed = { ...original, label: "New label" };
    const plan = planDeviceHostUpdates(
      [
        { environmentId: primary, label: "Local", connected: true, hosts: [original] },
        {
          environmentId: remote,
          label: "Remote",
          connected: true,
          hosts: [{ ...host, id: "remote-host", identityFile: "/remote/key" }, sibling],
        },
        { environmentId: offline, label: "Offline", connected: false, hosts: null },
      ],
      changed,
      original,
      false,
      false,
    );
    expect(plan.failed).toEqual(["Offline"]);
    expect(plan.writes).toEqual([
      { environmentId: primary, label: "Local", hosts: [changed] },
      {
        environmentId: remote,
        label: "Remote",
        hosts: [{ ...changed, id: "remote-host", identityFile: "/remote/key" }, sibling],
      },
    ]);
  });

  it("does not write a target where the host is already absent on removal", () => {
    const primary = EnvironmentId.make("local");
    expect(
      planDeviceHostUpdates(
        [{ environmentId: primary, label: "Local", connected: true, hosts: [sibling] }],
        host,
        host,
        true,
        false,
      ),
    ).toEqual({ writes: [], failed: [] });
  });
});
