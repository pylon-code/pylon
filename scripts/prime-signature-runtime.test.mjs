import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const serverRequire = NodeModule.createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const { crypto: sigstoreCrypto } = serverRequire("@sigstore/core");
const tufRequire = NodeModule.createRequire(serverRequire.resolve("@sigstore/tuf"));
const clientRequire = NodeModule.createRequire(tufRequire.resolve("tuf-js"));
const modelsRequire = NodeModule.createRequire(clientRequire.resolve("@tufjs/models"));
const { verifySignature } = modelsRequire(
  NodePath.join(NodePath.dirname(clientRequire.resolve("@tufjs/models")), "utils/verify.js"),
);
const { canonicalize } = modelsRequire("@tufjs/canonical-json");
const nativeVerify = NodeCrypto.verify;

// Electron/BoringSSL rejects the implicit SHA-256 digest accepted by Node/OpenSSL.
// Exercise the actual installed dependencies with that runtime behavior on every CI host.
function requireExplicitDigest() {
  vi.spyOn(serverRequire("node:crypto"), "verify").mockImplementation(
    (algorithm, data, key, signature) => {
      const material = typeof key === "object" && "key" in key ? key.key : key;
      const publicKey =
        material instanceof NodeCrypto.KeyObject ? material : NodeCrypto.createPublicKey(material);
      if (algorithm == null && ["ec", "rsa", "rsa-pss"].includes(publicKey.asymmetricKeyType)) {
        throw new Error("NO_DEFAULT_DIGEST");
      }
      return nativeVerify(algorithm, data, key, signature);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

const keys = [
  {
    name: "ECDSA",
    ...NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    algorithm: "sha256",
  },
  {
    name: "RSA",
    ...NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
    algorithm: "sha256",
  },
  { name: "Ed25519", ...NodeCrypto.generateKeyPairSync("ed25519"), algorithm: null },
];

describe("Prime signed publications on Electron", () => {
  for (const key of keys) {
    it(`verifies Sigstore ${key.name} and rejects modified data and signatures`, () => {
      const data = Buffer.from("signed Prime publication");
      const signature = NodeCrypto.sign(key.algorithm, data, key.privateKey);
      const modified = Buffer.from(signature);
      modified[0] ^= 1;
      requireExplicitDigest();
      for (const publicKey of [
        key.publicKey,
        key.publicKey.export({ type: "spki", format: "pem" }),
      ]) {
        expect(sigstoreCrypto.verify(data, publicKey, signature)).toBe(true);
        expect(
          sigstoreCrypto.verify(Buffer.from("different publication"), publicKey, signature),
        ).toBe(false);
        expect(sigstoreCrypto.verify(data, publicKey, modified)).toBe(false);
      }
    });

    it(`verifies TUF ${key.name} and rejects modified metadata`, () => {
      const metadata = { version: 1, role: "root", expires: "2030-01-01T00:00:00Z" };
      const options =
        key.name === "RSA" ? { padding: NodeCrypto.constants.RSA_PKCS1_PSS_PADDING } : {};
      const signature = NodeCrypto.sign(key.algorithm, Buffer.from(canonicalize(metadata)), {
        key: key.privateKey,
        ...options,
      }).toString("hex");
      requireExplicitDigest();
      expect(verifySignature(metadata, { key: key.publicKey, ...options }, signature)).toBe(true);
      expect(
        verifySignature({ ...metadata, version: 2 }, { key: key.publicKey, ...options }, signature),
      ).toBe(false);
    });
  }

  it("preserves an explicit non-default digest and rejects malformed keys", () => {
    const key = keys[0];
    const data = Buffer.from("explicit SHA-384");
    const signature = NodeCrypto.sign("sha384", data, key.privateKey);
    requireExplicitDigest();
    expect(sigstoreCrypto.verify(data, key.publicKey, signature, "sha384")).toBe(true);
    expect(sigstoreCrypto.verify(data, key.publicKey, signature, "sha256")).toBe(false);
    expect(sigstoreCrypto.verify(data, "invalid key", signature)).toBe(false);
  });
});
