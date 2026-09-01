import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderBindingConflictNotice } from "./ProviderBindingConflictNotice";

describe("ProviderBindingConflictNotice", () => {
  it("requires an explicit bound-provider or new-thread choice", () => {
    const markup = renderToStaticMarkup(
      <ProviderBindingConflictNotice
        originalProviderName="Codex Personal"
        boundProviderName="Claude Work"
        canContinueOnBoundProvider
        isStartingNewThread={false}
        onContinueOnBoundProvider={() => {}}
        onStartNewThread={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-composer-provider-binding-conflict="true"');
    expect(markup).toContain("Nothing will be retargeted until you choose");
    expect(markup).toContain("Continue on Claude Work");
    expect(markup).toContain("Start new thread on Codex Personal");
  });

  it("keeps new-thread recovery available while bound settings are missing", () => {
    const markup = renderToStaticMarkup(
      <ProviderBindingConflictNotice
        originalProviderName="prime_personal"
        boundProviderName="missing_account"
        canContinueOnBoundProvider={false}
        isStartingNewThread={false}
        onContinueOnBoundProvider={() => {}}
        onStartNewThread={() => {}}
      />,
    );

    expect(markup).toContain("Continue on missing_account");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Start new thread on prime_personal");
    expect(markup).toContain("bound account settings are still syncing");
  });
});
