---
name: ship-pylon-mobile
description: Deliver or diagnose a physical iPhone Pylon build, including EAS, OTA compatibility, and rollback.
---

# Ship Pylon Mobile

Use this for physical iPhone delivery. Simulator/emulator verification belongs to [test-pylon-mobile](../test-pylon-mobile/SKILL.md).

The `preview:local` profile uses `appVersion`, so Expo does not reject a bundle merely because its native inputs differ from the installed binary. An OTA publishes the whole working tree bundle, not just the requested diff. Compare fingerprints before every proposed OTA.

For delivery or installed-build diagnosis, run the read-only repository helper:

```bash
.agents/skills/ship-pylon-mobile/scripts/phone-status.sh
```

`OTA SAFE` permits an OTA candidate; `REBUILD REQUIRED` or `UNKNOWN` requires a rebuild. Changed filenames or a small JS diff do not establish native compatibility. Confirm the current profile/config if it differs from these documented assumptions.

- For a broken installed app, use [diagnosis](references/diagnosis.md) to distinguish bundle failure from client/server contract drift.
- Before building, publishing, or rolling back, read [delivery](references/delivery.md) for exact profiles, environment flags, installation, and the bounded cherry-pick fallback.

Diagnosis is read-only. EAS quota use and changing the phone require developer authorization; honor authorization already provided for that action. Do not publish an incompatible OTA as an experiment. Production builds go through the CI workflow, never a laptop. Report build, publication, installation, and actual verification separately.
