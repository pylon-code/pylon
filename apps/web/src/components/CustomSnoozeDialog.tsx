import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Choice = { readonly snoozedUntil: string };
type Request = { readonly id: number; readonly resolve: (choice: Choice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
const mountedRequests = new Set<number>();
let nextRequestId = 0;

export function requestCustomSnooze(): Promise<Choice | null> {
  useRequest.getState().request?.resolve(null);
  const id = ++nextRequestId;
  return new Promise((resolve) => useRequest.setState({ request: { id, resolve } }));
}

function finish(id: number, choice: Choice | null) {
  const request = useRequest.getState().request;
  if (request?.id !== id) return;
  useRequest.setState({ request: null });
  request.resolve(choice);
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? <CustomSnoozeDialog key={request.id} requestId={request.id} /> : null;
}

function CustomSnoozeDialog(props: { readonly requestId: number }) {
  useEffect(() => {
    mountedRequests.add(props.requestId);
    return () => {
      mountedRequests.delete(props.requestId);
      // Effect replay remounts before this microtask; true unmount settles
      // only this request, never a replacement opened meanwhile.
      queueMicrotask(() => {
        if (!mountedRequests.has(props.requestId)) finish(props.requestId, null);
      });
    };
  }, [props.requestId]);
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(localSnoozeDate(initial));
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(props.requestId, null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const input: CustomSnoozeInput =
              mode === "date" ? { mode, date, time } : { mode, amount, unit };
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? "Choose a valid future date and time."
                  : "Enter a positive duration.",
              );
              return;
            }
            finish(props.requestId, { snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when the thread returns to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <fieldset className="flex gap-3 text-sm">
              <legend className="sr-only">Snooze schedule type</legend>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="snooze-mode"
                  checked={mode === "date"}
                  onChange={() => {
                    setMode("date");
                    setError(null);
                  }}
                />
                Date and time
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="snooze-mode"
                  checked={mode === "duration"}
                  onChange={() => {
                    setMode("duration");
                    setError(null);
                  }}
                />
                Duration
              </label>
            </fieldset>
            {mode === "date" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="custom-snooze-date">Date</Label>
                  <Input
                    id="custom-snooze-date"
                    type="date"
                    required
                    value={date}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="custom-snooze-time">Time</Label>
                  <Input
                    id="custom-snooze-time"
                    type="time"
                    required
                    value={time}
                    onChange={(event) => {
                      setTime(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="custom-snooze-amount">Snooze for</Label>
                  <Input
                    id="custom-snooze-amount"
                    type="number"
                    min="0.01"
                    step="any"
                    required
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="custom-snooze-unit">Unit</Label>
                  <select
                    id="custom-snooze-unit"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value as typeof unit)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(props.requestId, null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
