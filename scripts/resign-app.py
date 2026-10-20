#!/usr/bin/env python3
"""
Re-sign a macOS .app bundle from the inside out.

Why this exists
---------------
Rebuilding Get It produces an unsigned (or ad-hoc signed) bundle. macOS then
refuses to launch it, and `codesign --deep --force` is NOT a fix: --deep signs
nested code in an unspecified order and routinely breaks the dyld shared cache
chain, producing an app that launches to 32 KB RSS and never draws a window.

This script signs in the order the loader actually validates:

    1. every Mach-O inside the bundle, deepest path first
    2. each *.framework  (Versions/A first, then the framework itself)
    3. each *.app inside Contents/Frameworks  (Electron helpers)
    4. Contents/MacOS/<CFBundleExecutable>
    5. the bundle itself

Step 2 is the one people miss. Signing libEGL.dylib but not the framework that
contains it leaves the outer seal stale, and verification fails with
"a sealed resource is missing or invalid / file modified: libEGL.dylib".

Mach-O detection reads the 4-byte magic instead of shelling out to `file`,
which is ~100x faster on a 2 GB bundle (a full `file` pass takes minutes).

Usage
-----
    # ad-hoc (no certificate needed, works for local use)
    python3 scripts/resign-app.py "/Applications/Get It BYOK.app"

    # with a self-signed or Developer ID certificate
    python3 scripts/resign-app.py "/path/to/App.app" \
        --identity "My Local Signing" \
        --keychain ~/Library/Keychains/signing.keychain-db \
        --keychain-password secret \
        --entitlements entitlements.plist

Notes
-----
* `--options runtime` (hardened runtime) is deliberately NOT applied. Get It is
  distributed without it, and adding it without a matching provisioning profile
  changes the signature flags in a way that can break the app.
* Entitlements are applied only to the helpers, the main executable and the
  bundle. Applying them to every dylib is wrong and makes codesign complain.
"""

import argparse
import os
import plistlib
import subprocess
import sys

MAGICS = {
    b"\xca\xfe\xba\xbe",  # fat / universal
    b"\xcf\xfa\xed\xfe",  # 64-bit little endian
    b"\xce\xfa\xed\xfe",  # 32-bit little endian
    b"\xfe\xed\xfa\xcf",  # 64-bit big endian
    b"\xfe\xed\xfa\xce",  # 32-bit big endian
}


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0, (r.stderr or r.stdout).strip()


def is_macho(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) in MAGICS
    except OSError:
        return False


def bundle_executable(app):
    """Read CFBundleExecutable so we never hard-code an app name."""
    plist = os.path.join(app, "Contents", "Info.plist")
    try:
        with open(plist, "rb") as f:
            return plistlib.load(f).get("CFBundleExecutable")
    except (OSError, plistlib.InvalidFileException):
        return None


def main():
    ap = argparse.ArgumentParser(description="Re-sign a .app bundle inside-out.")
    ap.add_argument("app", help="path to the .app bundle")
    ap.add_argument("--identity", default="-",
                    help='codesign identity; "-" means ad-hoc (default)')
    ap.add_argument("--keychain", default=None,
                    help="keychain holding the identity (optional)")
    ap.add_argument("--keychain-password", default=None,
                    help="password for --keychain, if it is locked")
    ap.add_argument("--entitlements", default=None,
                    help="entitlements plist applied to helpers and the main bundle")
    args = ap.parse_args()

    app = os.path.abspath(args.app)
    if not os.path.isdir(app):
        sys.exit(f"not a directory: {app}")

    exe_name = bundle_executable(app)
    if not exe_name:
        sys.exit("cannot read CFBundleExecutable from Contents/Info.plist")

    # A keychain that is not in the search list makes `codesign --keychain`
    # fail with "item not found", even when the path is correct.
    login_kc = os.path.expanduser("~/Library/Keychains/login.keychain-db")
    if args.keychain:
        kc = os.path.abspath(os.path.expanduser(args.keychain))
        run(["security", "list-keychains", "-d", "user", "-s", login_kc, kc])
        if args.keychain_password:
            run(["security", "unlock-keychain", "-p", args.keychain_password, kc])

    def sign(target, entitlements=False):
        cmd = ["codesign", "--force", "--sign", args.identity, "--timestamp=none"]
        if args.keychain:
            cmd += ["--keychain", os.path.abspath(os.path.expanduser(args.keychain))]
        if entitlements and args.entitlements:
            cmd += ["--entitlements", os.path.abspath(args.entitlements)]
        cmd.append(target)
        return run(cmd)

    print("=" * 62)
    print(f"re-signing {os.path.basename(app)}")
    print(f"  identity : {args.identity}")
    print(f"  helpers  : entitlements={'yes' if args.entitlements else 'no'}")
    print("=" * 62)

    if args.identity != "-":
        ok, out = run(["security", "find-identity", "-v", "-p", "codesigning"]
                      + ([os.path.abspath(os.path.expanduser(args.keychain))]
                         if args.keychain else []))
        if args.identity not in out:
            sys.exit(f"identity not found: {args.identity}\n{out}")
        print("identity available\n")

    # ---------- 1. every Mach-O, deepest first ----------
    print("[1/5] scanning Mach-O...")
    machos = []
    for root, _dirs, files in os.walk(app):
        for name in files:
            p = os.path.join(root, name)
            if os.path.islink(p):
                continue
            if is_macho(p):
                machos.append(p)
    print(f"  found {len(machos)}")

    # ---------- 2. sign them ----------
    print("[2/5] signing Mach-O (inside out)...")
    machos.sort(key=lambda p: p.count(os.sep), reverse=True)
    failed = 0
    for p in machos:
        ok, msg = sign(p)
        if not ok:
            failed += 1
            print(f"  ! {os.path.relpath(p, app)}: {msg[:90]}")
    print(f"  done, {failed} failed")

    fw_dir = os.path.join(app, "Contents", "Frameworks")

    # ---------- 3. frameworks ----------
    print("[3/5] signing frameworks...")
    if os.path.isdir(fw_dir):
        for name in sorted(os.listdir(fw_dir)):
            if not name.endswith(".framework"):
                continue
            fw = os.path.join(fw_dir, name)
            versions_a = os.path.join(fw, "Versions", "A")
            if os.path.isdir(versions_a):
                ok, msg = sign(versions_a)
                if not ok:
                    print(f"  ! {name}/Versions/A: {msg[:80]}")
            ok, msg = sign(fw)
            print(f"  {'ok ' if ok else 'FAIL'} {name}")
            if not ok:
                print(f"       {msg[:150]}")

    # ---------- 4. helper apps ----------
    print("[4/5] signing helper apps...")
    if os.path.isdir(fw_dir):
        for name in sorted(os.listdir(fw_dir)):
            if name.endswith(".app"):
                ok, _ = sign(os.path.join(fw_dir, name), entitlements=True)
                print(f"  {'ok ' if ok else 'FAIL'} {name}")

    # ---------- 5. main executable + bundle ----------
    print("[5/5] signing main executable and bundle...")
    main_exe = os.path.join(app, "Contents", "MacOS", exe_name)
    if os.path.exists(main_exe):
        sign(main_exe, entitlements=True)
    ok, msg = sign(app, entitlements=True)
    print(f"  {'ok ' if ok else 'FAIL'} {os.path.basename(app)}")
    if not ok:
        print("  " + msg[:300])

    if args.keychain:
        run(["security", "list-keychains", "-d", "user", "-s", login_kc])

    # ---------- verify ----------
    print("\n" + "=" * 62)
    print("verify")
    print("=" * 62)
    verify_ok, out = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    print(f"codesign --verify : {'PASS' if verify_ok else 'FAIL'}")
    if not verify_ok:
        for line in out.splitlines()[-8:]:
            print("   " + line[:150])

    _ok, out = run(["spctl", "-a", "-vvv", "--type", "execute", app])
    lines = out.splitlines()
    print(f"spctl -a          : {lines[0] if lines else '(no output)'}")
    for line in lines[1:3]:
        print(f"                    {line}")

    # An ad-hoc signature has no certificate chain, so spctl always answers
    # "rejected". That is not a failure of this script and must not be read as
    # one — the bundle is internally consistent, which is what codesign says.
    if args.identity == "-":
        print()
        print("note: ad-hoc signatures carry no certificate chain, so spctl")
        print("      always reports 'rejected'. Verification above is what")
        print("      matters. If the app still will not launch, run")
        print("      scripts/fix-gatekeeper-inode.sh — the block is usually")
        print("      the syspolicyd inode cache, not the signature.")

    sys.exit(0 if verify_ok else 1)


if __name__ == "__main__":
    main()
