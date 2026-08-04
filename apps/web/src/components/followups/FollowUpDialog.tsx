import {
  CommandId,
  FollowUpId,
  type FollowUpDeferReason,
  type FollowUpKind,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import { randomUUID } from "~/lib/utils";
import { followUpEnvironment } from "~/state/followups";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { FOLLOW_UP_DEFER_REASON_LABELS } from "./followUps.logic";

const KIND_ITEMS: ReadonlyArray<{ readonly value: FollowUpKind; readonly label: string }> = [
  { value: "blocker", label: "Blocker" },
  { value: "open", label: "Open work" },
  { value: "idea", label: "Idea" },
];

const DEFER_REASON_ITEMS: ReadonlyArray<{
  readonly value: FollowUpDeferReason;
  readonly label: string;
}> = [
  { value: "out-of-scope", label: FOLLOW_UP_DEFER_REASON_LABELS["out-of-scope"] },
  { value: "needs-decision", label: FOLLOW_UP_DEFER_REASON_LABELS["needs-decision"] },
  { value: "blocked-externally", label: FOLLOW_UP_DEFER_REASON_LABELS["blocked-externally"] },
  { value: "idea", label: FOLLOW_UP_DEFER_REASON_LABELS.idea },
];

export function FollowUpDialog({
  projectRef,
  projectTitle,
  onClose,
}: {
  readonly projectRef: ScopedProjectRef;
  readonly projectTitle: string;
  readonly onClose: () => void;
}) {
  const fileFollowUp = useAtomCommand(followUpEnvironment.file, "file follow-up");
  const [title, setTitle] = useState("");
  const [observation, setObservation] = useState("");
  const [kind, setKind] = useState<FollowUpKind>("open");
  const [deferReason, setDeferReason] = useState<FollowUpDeferReason>("out-of-scope");
  const [verifyCheck, setVerifyCheck] = useState("");
  const [branchRef, setBranchRef] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const canSubmit =
    title.trim().length > 0 &&
    observation.trim().length > 0 &&
    verifyCheck.trim().length > 0 &&
    (kind !== "blocker" || branchRef.trim().length > 0);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || isSaving) return;

    setIsSaving(true);
    const result = await fileFollowUp({
      environmentId: projectRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        itemId: FollowUpId.make(randomUUID()),
        projectId: projectRef.projectId,
        kind,
        title: title.trim(),
        observation: observation.trim(),
        deferReason,
        verifyCheck: verifyCheck.trim(),
        evidence: [],
        gate: kind === "blocker" ? { kind: "branch", ref: branchRef.trim() } : null,
        sourceKind: "human",
        sourceThreadId: null,
      },
    });
    setIsSaving(false);

    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Follow-up added" });
      onClose();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Couldn’t add follow-up",
      description: "The dossier was not saved. Try again.",
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="overflow-hidden">
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add follow-up</DialogTitle>
            <DialogDescription>
              Capture deferred work for {projectTitle}. Keep the verify check falsifiable.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input
                autoFocus
                maxLength={200}
                required
                value={title}
                onValueChange={setTitle}
                placeholder="What needs attention?"
              />
            </Field>
            <Field>
              <FieldLabel>Observation</FieldLabel>
              <Textarea
                maxLength={8000}
                required
                value={observation}
                onChange={(event) => setObservation(event.target.value)}
                placeholder="What did you observe?"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Kind</FieldLabel>
                <Select
                  items={KIND_ITEMS}
                  value={kind}
                  onValueChange={(value) => value && setKind(value as FollowUpKind)}
                >
                  <SelectTrigger aria-label="Follow-up kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {KIND_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Why defer?</FieldLabel>
                <Select
                  items={DEFER_REASON_ITEMS}
                  value={deferReason}
                  onValueChange={(value) => value && setDeferReason(value as FollowUpDeferReason)}
                >
                  <SelectTrigger aria-label="Defer reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {DEFER_REASON_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>Verify check</FieldLabel>
              <Textarea
                maxLength={2000}
                required
                value={verifyCheck}
                onChange={(event) => setVerifyCheck(event.target.value)}
                placeholder="What exact check proves this is handled?"
              />
            </Field>
            {kind === "blocker" ? (
              <Field>
                <FieldLabel>Gated branch</FieldLabel>
                <Input
                  maxLength={300}
                  required
                  value={branchRef}
                  onValueChange={setBranchRef}
                  placeholder="main"
                />
              </Field>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button disabled={isSaving} onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canSubmit || isSaving} type="submit">
              {isSaving ? "Adding…" : "Add follow-up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
