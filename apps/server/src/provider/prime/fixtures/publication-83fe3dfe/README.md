# Immutable publication fixture

Public evidence from [preview run 34630984964](https://github.com/pylon-code/prime-agent/actions/runs/34630984964)
and [its immutable release](https://github.com/pylon-code/prime-agent/releases/tag/pylon-build-g83fe3dfe3f10-r1).
Source: `83fe3dfe3f109dc767e6be4a4b7509c0ca1f536d`; tree: `6ecea91dcd8534adca55aa42a4398040ce81d0a9`.

- Release manifest SHA-256: `67ed1d7afcf9b219dc71a009e4ed6f59f6e16995671c6c75bd564402dad946c0`.
- Preview manifest SHA-256: `faacd5f710e0a2ffa9e747329e79f7535e42a19453318726849136754a638cd8`.
- Preview workflow SHA-256: `16f68e46801eccca5e7e99736f346b5ffd96ce7188792d4ac8fbc4580408a736`.
- `preview-attestation.json` is the public six-subject Sigstore bundle returned by GitHub for the preview manifest digest.
- `trusted-root.ts` preserves the trust material returned by Sigstore's TUF client on 2026-09-11, with decoded bytes and dates, for offline cryptographic verification.

The manifests and `.yml.txt` workflow retain their exact published bytes. Do not reformat them or regenerate
the manifests through the verifier's serializer. The workflow uses a text suffix to prevent YAML formatting.
No private keys, credentials, package archives, or runtime state are included.
