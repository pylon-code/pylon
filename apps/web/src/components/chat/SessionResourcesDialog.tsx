import type {
  SessionResourceInventory,
  SessionResourcesSnapshot,
} from "@t3tools/client-runtime/state/session-resources";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const PAGE_SIZE = 50;

type SessionResource = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly scope?: "user" | "project" | "temporary" | undefined;
  readonly argumentHint?: string | undefined;
};

export function SessionResourceList({
  emptyLabel,
  items,
  visibleCount,
  onShowMore,
}: {
  readonly emptyLabel: string;
  readonly items: ReadonlyArray<SessionResource>;
  readonly visibleCount: number;
  readonly onShowMore: () => void;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const occurrences = new Map<string, number>();
  const visibleItems = items.slice(0, visibleCount).map((item) => {
    const baseKey = JSON.stringify([item.name, item.description, item.argumentHint, item.scope]);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return { item, key: `${baseKey}:${occurrence}` };
  });

  return (
    <div className="grid gap-2">
      {visibleItems.map(({ item, key }) => (
        <div key={key} className="rounded-lg border bg-muted/30 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="break-all text-sm font-medium text-foreground">{item.name}</span>
            {item.argumentHint === undefined ? null : (
              <span className="break-all font-mono text-xs text-muted-foreground">
                {item.argumentHint}
              </span>
            )}
            {item.scope === undefined ? null : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {item.scope}
              </span>
            )}
          </div>
          {item.description === undefined ? null : (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
              {item.description}
            </p>
          )}
        </div>
      ))}
      {visibleCount < items.length ? (
        <Button type="button" variant="outline" size="sm" onClick={onShowMore}>
          Show {Math.min(PAGE_SIZE, items.length - visibleCount)} more
        </Button>
      ) : null}
    </div>
  );
}

export function SessionResourcesDialog({
  identity,
  inventory,
  snapshot,
  open,
  onOpenChange,
  showReload,
  reloadDisabled,
  isReloading,
  onReload,
}: {
  readonly identity: string;
  readonly inventory: SessionResourceInventory;
  readonly snapshot: SessionResourcesSnapshot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly showReload: boolean;
  readonly reloadDisabled: boolean;
  readonly isReloading: boolean;
  readonly onReload: () => Promise<void>;
}) {
  const [visibleSkills, setVisibleSkills] = useState(PAGE_SIZE);
  const [visiblePrompts, setVisiblePrompts] = useState(PAGE_SIZE);

  useEffect(() => {
    setVisibleSkills(PAGE_SIZE);
    setVisiblePrompts(PAGE_SIZE);
  }, [identity, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Session resources</DialogTitle>
          <DialogDescription>
            Saved skill and prompt metadata for this provider session. Resource contents and paths
            are not shown.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-5 overflow-y-auto">
          {inventory.showSkills ? (
            <section aria-labelledby="session-resource-skills">
              <h3 id="session-resource-skills" className="mb-2 text-sm font-semibold">
                Skills · {inventory.skills.length}
              </h3>
              <SessionResourceList
                items={inventory.skills}
                emptyLabel="No skills available for this session."
                visibleCount={visibleSkills}
                onShowMore={() => setVisibleSkills((count) => count + PAGE_SIZE)}
              />
            </section>
          ) : null}
          {inventory.showPrompts ? (
            <section aria-labelledby="session-resource-prompts">
              <h3 id="session-resource-prompts" className="mb-2 text-sm font-semibold">
                Prompts · {inventory.prompts.length}
              </h3>
              <SessionResourceList
                items={inventory.prompts}
                emptyLabel="No prompts available for this session."
                visibleCount={visiblePrompts}
                onShowMore={() => setVisiblePrompts((count) => count + PAGE_SIZE)}
              />
            </section>
          ) : null}
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Saved{" "}
            <time dateTime={snapshot.updatedAt}>
              {new Date(snapshot.updatedAt).toLocaleString()}
            </time>
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {showReload ? (
            <Button
              type="button"
              disabled={reloadDisabled || isReloading}
              onClick={() => void onReload()}
            >
              {isReloading ? "Reloading…" : "Reload resources"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
