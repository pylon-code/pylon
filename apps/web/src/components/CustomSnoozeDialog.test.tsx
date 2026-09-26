import { StrictMode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "section",
  DialogFooter: "footer",
}));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/label", () => ({ Label: "label" }));
vi.mock("./ui/button", () => ({ Button: "button" }));

import { CustomSnoozeDialogHost, requestCustomSnooze } from "./CustomSnoozeDialog";

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await Promise.resolve();
  });
  renderer = null;
});

it("does not let a replaced dialog close or submit its newer request", async () => {
  await act(async () => {
    renderer = create(<CustomSnoozeDialogHost />);
  });
  let first!: Promise<{ readonly snoozedUntil: string } | null>;
  await act(async () => {
    first = requestCustomSnooze();
  });
  const staleClose = renderer!.root.findByType("dialog").props.onOpenChange as (
    open: boolean,
  ) => void;
  const staleSubmit = renderer!.root.findByType("form").props.onSubmit as (event: {
    preventDefault: () => void;
  }) => void;
  let second!: Promise<{ readonly snoozedUntil: string } | null>;
  await act(async () => {
    second = requestCustomSnooze();
  });
  expect(await first).toBeNull();
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await act(async () => {
    staleClose(false);
    staleSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  expect(secondSettled).toBe(false);
  const dateInput = renderer!.root
    .findAllByType("input")
    .find((node) => node.props.type === "date");
  expect(dateInput).toBeDefined();
  await act(async () => {
    dateInput!.props.onChange({ target: { value: "2099-01-01" } });
  });
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect((await second)?.snoozedUntil).toMatch(/^2099-01-01T/);
});

it("settles only its mounted request when the host unmounts", async () => {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <CustomSnoozeDialogHost />
      </StrictMode>,
    );
  });
  let pending!: Promise<{ readonly snoozedUntil: string } | null>;
  await act(async () => {
    pending = requestCustomSnooze();
    await Promise.resolve();
  });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  expect(settled).toBe(false);
  await act(async () => {
    renderer?.unmount();
    await Promise.resolve();
  });
  expect(await pending).toBeNull();
});
