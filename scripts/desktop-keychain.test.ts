// @effect-diagnostics nodeBuiltinImport:off - evaluates the installed CommonJS signing module in a VM with mocked security commands.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

const desktopRequire = NodeModule.createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
const signingModulePath = builderRequire.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
const signingRequire = NodeModule.createRequire(signingModulePath);

describe("desktop signing keychain", () => {
  it.each([false, true])(
    "unlocks imported keys with the keychain password (installer certificate: %s)",
    async (includeInstaller) => {
      const commands: string[][] = [];
      let keychainPassword: string | undefined;
      const exports = {} as {
        createKeychain: (options: {
          tmpDir: undefined;
          currentDir: string;
          cscLink: string;
          cscKeyPassword: string;
          cscILink?: string;
          cscIKeyPassword?: string;
        }) => Promise<{ keychainFile: string }>;
      };
      NodeVM.runInNewContext(NodeFS.readFileSync(signingModulePath, "utf8"), {
        exports,
        // Skip the bundled root-certificate cache. No real keychain or file is touched.
        process: { env: { TRAVIS: "true" } },
        require(id: string) {
          if (id === "builder-util") {
            return {
              async exec(command: string, args: string[]) {
                expect(command).toBe("/usr/bin/security");
                commands.push(args);
                if (args[0] === "create-keychain") keychainPassword = args[2];
                if (args[0] === "set-key-partition-list") {
                  if (args[args.indexOf("-k") + 1] !== keychainPassword) {
                    throw new Error("The keychain password does not match");
                  }
                }
                return "";
              },
            };
          }
          if (id === "./codesign") {
            return { importCertificate: async (link: string) => `/fixtures/${link}.p12` };
          }
          return signingRequire(id);
        },
      });

      const result = await exports.createKeychain({
        tmpDir: undefined,
        currentDir: "/fixtures/pylon-desktop-stage",
        cscLink: "application",
        cscKeyPassword: "application-certificate-password",
        ...(includeInstaller
          ? { cscILink: "installer", cscIKeyPassword: "installer-certificate-password" }
          : {}),
      });

      expect(keychainPassword).toBeTruthy();
      expect(keychainPassword).not.toBe("application-certificate-password");
      const imports = commands.filter(([command]) => command === "import");
      expect(imports.map((args) => args[args.indexOf("-P") + 1])).toEqual(
        includeInstaller
          ? ["application-certificate-password", "installer-certificate-password"]
          : ["application-certificate-password"],
      );
      const permissions = commands.filter(([command]) => command === "set-key-partition-list");
      expect(permissions).toHaveLength(imports.length);
      for (const args of permissions) {
        expect(args[args.indexOf("-k") + 1]).toBe(keychainPassword);
        expect(args.at(-1)).toBe(result.keychainFile);
      }
    },
  );
});
