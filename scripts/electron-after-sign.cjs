/**
 * scripts/electron-after-sign.cjs
 *
 * electron-builder `afterSign` hook. Runs after the app bundle is
 * staged but before the .dmg is built. Two branches live here:
 *
 *   • Developer ID signing (env GETIT_MAC_SIGNING_MODE=developer-id*)
 *     — `scripts/build-electron.mjs` detected a "Developer ID
 *     Application" cert in the keychain and passed flags to
 *     electron-builder so it signs every Mach-O with the cert (and,
 *     when `mode=developer-id`, sends the bundle to Apple's notary
 *     service and staples the ticket onto the .app). The afterSign
 *     hook **does nothing in this branch** — overwriting the
 *     Developer-ID signature with `codesign --sign -` would replace
 *     a trusted signature with an ad-hoc one and break Gatekeeper /
 *     notarization. We only verify the signature is still good.
 *
 *   • Ad-hoc fallback (no Developer ID cert detected, or
 *     `CSC_IDENTITY_AUTO_DISCOVERY=false`) — same old behaviour: we
 *     run `codesign --sign -` over every Mach-O so the Apple Silicon
 *     kernel's mandatory-signature check passes (without this, M-
 *     series Macs report a fresh download as "damaged" rather than
 *     showing the bypassable Gatekeeper prompt). The first launch
 *     still requires a one-time System Settings → Privacy & Security
 *     → Open Anyway dance — a Developer-ID + notarize combination
 *     removes that prompt entirely.
 *
 * No-op on Windows / Linux (electron-builder calls afterSign on every
 * target with `electronPlatformName` set accordingly).
 */

"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`[after-sign] expected ${appPath} but it does not exist; skipping.`);
    return;
  }

  const mode = process.env.GETIT_MAC_SIGNING_MODE || "ad-hoc";

  if (mode === "electron-builder-adhoc") {
    // electron-builder skipped signing (CSC_IDENTITY_AUTO_DISCOVERY=false), so
    // this hook is the only signer. Delegate to sign-adhoc.py: it walks the
    // bundle inside-out and applies entitlements only to the app and its
    // helpers. A single `codesign --deep` pass here stamps allow-jit onto the
    // framework dylibs too, which breaks dyld's chain-of-trust and leaves the
    // process suspended at ~32 KB RSS with no window and no error output.
    console.log(`[after-sign] mode=${mode} — signing inside-out via sign-adhoc.py`);
    execFileSync(
      "python3",
      [path.join(__dirname, "sign-adhoc.py"), appPath],
      { stdio: "inherit", cwd: path.join(__dirname, "..") },
    );
    return;
  }

  if (mode === "developer-id" || mode === "developer-id-no-notary") {
    // electron-builder already signed everything with the Developer
    // ID cert (and, for `developer-id`, will go on to notarize +
    // staple in a later step). Touching the signature here would
    // downgrade it to ad-hoc and break Gatekeeper. Just verify the
    // existing signature looks healthy and log so the build output
    // shows what branch ran.
    console.log(`[after-sign] mode=${mode} — leaving Developer ID signature in place; verifying`);
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
    console.log(`[after-sign] Developer ID signature verified.`);
    return;
  }

  // mode === "ad-hoc" (or unset, treated as ad-hoc for legacy parity).
  //
  // `--force` replaces any pre-existing signature (Electron ships its
  // framework pre-signed by the upstream project; if we leave that in
  // place the outer ad-hoc sig won't validate against the inner one).
  // `--deep` recurses into Frameworks/, Helpers, MachO inside Resources
  // (the bundled Codex Rust binary lives under .../app.asar.unpacked/
  // electron/codex-bin/.../codex).
  // `--sign -` is the documented ad-hoc identity sigil.
  // Entitlements are mandatory here, not cosmetic: Electron's V8 needs
  // `com.apple.security.cs.allow-jit` (and the unsigned-executable-memory
  // companion) to allocate executable pages. electron-builder skips signing
  // entirely when CSC_IDENTITY_AUTO_DISCOVERY=false, so this branch is the
  // only thing that signs the bundle — omitting --entitlements produces an
  // app that launches, never creates a window, and writes nothing to disk.
  const entitlementsPath = path.join(
    __dirname,
    "..",
    "electron",
    "assets",
    "entitlements.mac.plist",
  );
  const entitlementsArgs = fs.existsSync(entitlementsPath)
    ? ["--entitlements", entitlementsPath]
    : [];
  if (entitlementsArgs.length === 0) {
    console.warn(
      `[after-sign] WARNING: ${entitlementsPath} not found — the app will build but V8 will refuse to start.`,
    );
  }

  console.log(`[after-sign] mode=${mode} — ad-hoc signing ${appPath}`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", ...entitlementsArgs, appPath],
    { stdio: "inherit" },
  );

  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log(`[after-sign] ad-hoc signature verified.`);
};
