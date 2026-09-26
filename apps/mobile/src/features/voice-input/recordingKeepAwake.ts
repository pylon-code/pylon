import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { uuidv4 } from "../../lib/uuid";

type KeepAwakeBridge = {
  readonly activate: (tag: string) => Promise<void>;
  readonly deactivate: (tag: string) => Promise<void>;
};

export function holdRecordingAwake(
  bridge: KeepAwakeBridge = { activate: activateKeepAwakeAsync, deactivate: deactivateKeepAwake },
  createId: () => string = uuidv4,
): () => void {
  // An earlier native activation may settle after unmount or Fast Refresh.
  const tag = `voice-input:${createId()}`;
  const activation = bridge.activate(tag);
  void activation.catch(() => {});
  return () => {
    void activation.then(() => bridge.deactivate(tag)).catch(() => {});
  };
}
