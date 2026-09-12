import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

/** Authorization and bytes share one cancellation/deadline and one verified connection. */
export async function fetchImportedComposerAttachment<
  Connection extends { httpBaseUrl: string },
>(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly signal: AbortSignal;
  readonly readConnection: () => Connection | null;
  readonly authorize: (
    signal: AbortSignal,
  ) => Promise<
    | { readonly _tag: "Success"; readonly value: { readonly relativeUrl: string } }
    | { readonly _tag: "Failure" }
  >;
}): Promise<File> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    input.signal.throwIfAborted();
    const connection = input.readConnection();
    if (!connection) throw new Error("The environment it came from is not connected.");
    const result = await input.authorize(input.signal);
    input.signal.throwIfAborted();
    const currentConnection = input.readConnection();
    if (currentConnection !== connection) {
      if (attempt === 0) continue;
      throw new Error(
        "The source environment changed while authorizing the attachment. Try pasting again.",
      );
    }
    const url =
      result._tag === "Success"
        ? resolveAssetUrl(currentConnection.httpBaseUrl, result.value.relativeUrl)
        : null;
    if (!url) throw new Error("The original attachment is no longer available.");
    const response = await fetch(url, { signal: input.signal });
    if (!response.ok)
      throw new Error(`Downloading the original attachment failed (HTTP ${response.status}).`);
    const blob = await response.blob();
    input.signal.throwIfAborted();
    return new File([blob], input.name, { type: input.mimeType || blob.type });
  }
  throw new Error("The source environment changed. Try pasting again.");
}
