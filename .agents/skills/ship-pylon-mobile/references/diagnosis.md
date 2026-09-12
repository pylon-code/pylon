# Installed-app diagnosis

## Diagnosing an app that stopped working

Match the symptom before touching anything:

| Symptom                                            | Likely cause                       | Check                                                                            |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| Crashes on launch, or right after opening a thread | A bad OTA on `preview`             | `eas update:list --branch preview` — is the newest update newer than the binary? |
| Launches, cannot connect to a server               | Client/server contract drift       | Commit drift + changed contract files from the status script                     |
| Connects, individual screens broken or empty       | Contract drift in one feature area | `git diff <build-commit>..origin/pylon -- packages/contracts`                    |

Contract changes are usually additive and forward-compatible
(`Schema.optionalKey`, `ForwardCompatibleArray`), so drift alone is not proof.
Confirm against the actual symptom.
