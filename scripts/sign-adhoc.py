#!/usr/bin/env python3
"""Correct ad-hoc signing for an Electron .app bundle.

`codesign --deep --sign -` flattens the entitlement chain: it stamps
com.apple.security.cs.allow-jit onto every nested Mach-O including the
framework dylibs, which breaks dyld's signature validation and wedges the
process at ~32 KB RSS before main() runs.

This script signs inside-out instead:
  1. Electron Framework's inner helpers (no entitlements)
  2. Electron Framework itself (no entitlements)
  3. Other bundled frameworks (no entitlements)
  4. Each Helper .app (entitlements, --deep is safe: one binary each)
  5. The outer app (entitlements, no --deep)
"""
import glob
import os
import subprocess
import sys

APP = sys.argv[1] if len(sys.argv) > 1 else "dist-electron/mac/Get It.app"
_HERE = os.path.dirname(os.path.abspath(__file__))
ENT = os.path.join(_HERE, "..", "electron", "assets", "entitlements.mac.plist")
ENT = os.path.abspath(ENT)

if not os.path.isdir(APP):
    sys.exit(f"app not found: {APP}")
if not os.path.exists(ENT):
    sys.exit(f"entitlements not found: {ENT}")

failures = []


def sign(path, ent=False, deep=False):
    cmd = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    if deep:
        cmd.append("--deep")
    if ent:
        cmd += ["--entitlements", ENT]
    cmd.append(path)
    r = subprocess.run(cmd, capture_output=True, text=True)
    label = os.path.basename(path.rstrip("/"))
    if r.returncode == 0:
        print(f"  OK   {label}")
        return True
    print(f"  FAIL {label}: {r.stderr.strip()[:220]}")
    failures.append(path)
    return False


fw = os.path.join(APP, "Contents", "Frameworks")
efw = os.path.join(fw, "Electron Framework.framework", "Versions", "A")

print("[1/5] Electron Framework inner helpers")
for p in sorted(glob.glob(os.path.join(efw, "Helpers", "*"))):
    sign(p)

print("[2/5] Electron Framework")
sign(efw)

print("[3/5] other frameworks")
for name in ("Mantle.framework", "ReactiveObjC.framework", "Squirrel.framework"):
    base = os.path.join(fw, name, "Versions", "A")
    if not os.path.isdir(base):
        continue
    for root, _dirs, files in os.walk(base):
        for f in files:
            if f.endswith(".dylib"):
                sign(os.path.join(root, f))
    sign(base)

print("[4/5] helper apps")
for p in sorted(glob.glob(os.path.join(fw, "*.app"))):
    sign(p, ent=True, deep=True)

print("[5/5] outer app")
sign(APP, ent=True)

print()
if failures:
    print(f"FAILED: {len(failures)} path(s) could not be signed")
    sys.exit(1)

# Verify the outer bundle and confirm the JIT entitlement survived.
v = subprocess.run(["codesign", "--verify", "--deep", "--strict", APP],
                   capture_output=True, text=True)
print("verify --deep --strict:", "PASS" if v.returncode == 0 else "FAIL")
if v.returncode != 0:
    print(v.stderr.strip()[:400])

d = subprocess.run(["codesign", "-d", "--entitlements", "-", APP],
                   capture_output=True, text=True)
ent_text = d.stdout + d.stderr
print("allow-jit present:", "yes" if "allow-jit" in ent_text else "NO")
print("DONE")
