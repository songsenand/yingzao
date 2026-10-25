#!/usr/bin/env python3
"""Is this machine a usable Blender/bpy bay?

Run this *before* `python_runtime action=install packages:["bpy==5.2.3"]`:
it answers "will the 403 MB download even be installable here?" and "is bpy
already importable?" in one JSON object, without installing anything.

    python preflight.py --json
    run_python({ script: "skills/cad-art/preflight.py", args: ["--json"] })

Exit code is 0 for every *diagnosis* (ready / not-installed / unsupported /
low-disk / version-mismatch): a missing bpy is a fact to act on, not a tool
crash.  Only an internal error exits non-zero.  Use --require-ready when a
caller wants a hard gate.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

EXPECTED_BPY = "5.2.3"
EXPECTED_PY = (3, 13)
MIN_DISK_GB = 1.5


def _glibc_version() -> tuple[str, tuple[int, ...]]:
    libc, version = platform.libc_ver()
    if not version:
        return libc, ()
    parts: list[int] = []
    for piece in version.split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            break
    return libc, tuple(parts)


def platform_support() -> tuple[bool, str, str]:
    """(supported, target_key, reason). Mirrors bpy 5.2.x's published wheels."""
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Linux":
        libc, version = _glibc_version()
        if libc != "glibc":
            return False, "linux-unsupported-libc", f"libc={libc or 'unknown'} (bpy wheels are manylinux_2_28/glibc)"
        if version and version < (2, 28):
            return False, "linux-old-glibc", f"glibc {'.'.join(map(str, version))} < 2.28"
        if machine in {"x86_64", "amd64"}:
            return True, "linux-x64-gnu", "manylinux_2_28_x86_64"
        return False, f"linux-{machine}", f"no bpy 5.2.x wheel for Linux/{machine} (only x86_64)"
    if system == "Darwin":
        if machine in {"arm64", "aarch64"}:
            return True, "darwin-arm64", "macosx_11_0_arm64"
        return False, f"darwin-{machine}", f"no bpy 5.2.x wheel for macOS/{machine} (only arm64)"
    if system == "Windows":
        if machine in {"amd64", "x86_64"}:
            return True, "win32-x64", "win_amd64"
        if machine in {"arm64", "aarch64"}:
            return True, "win-arm64", "win_arm64 (bpy wheel exists; this project targets win32-x64)"
        return False, f"windows-{machine}", f"no bpy 5.2.x wheel for Windows/{machine}"
    return False, f"{system}-{machine}", f"unsupported platform {system}/{machine}"


def blender_cli() -> dict:
    candidates = [shutil.which("blender"), "/Applications/Blender.app/Contents/MacOS/Blender"]
    exe = next((candidate for candidate in candidates if candidate and os.path.exists(candidate)), None)
    if not exe:
        return {"found": False, "path": None, "version": None}
    try:
        result = subprocess.run(
            [exe, "--version"], capture_output=True, text=True, timeout=15
        )
        first = (result.stdout or result.stderr).splitlines()
        return {"found": True, "path": exe, "version": first[0].strip() if first else None}
    except Exception as error:  # noqa: BLE001 - a probe must never crash the report
        return {"found": True, "path": exe, "version": None, "error": str(error)}


def disk_free_gb() -> float:
    root = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    probe = root if root.exists() else Path.home()
    try:
        return shutil.disk_usage(probe).free / (1024 ** 3)
    except OSError:
        return -1.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="machine-readable object on stdout")
    parser.add_argument("--require-ready", action="store_true", help="exit 10 when bpy is not importable")
    parser.add_argument("--no-blender", action="store_true", help="skip the Blender CLI probe")
    parser.add_argument("--expect", default=EXPECTED_BPY, help=f"tested bpy version (default {EXPECTED_BPY})")
    args = parser.parse_args()

    supported, target, support_reason = platform_support()
    py_ok = sys.version_info[:2] == EXPECTED_PY
    free_gb = disk_free_gb()

    bpy_version = None
    bpy_error = None
    try:
        import bpy  # noqa: PLC0415 - the whole point is to probe the real import

        bpy_version = bpy.app.version_string
    except BaseException as error:  # noqa: BLE001 - a broken bpy often raises SystemExit
        bpy_error = f"{type(error).__name__}: {error}"

    if not supported:
        status = "unsupported"
    elif not py_ok:
        status = "unsupported-python"
    elif bpy_version is None and 0 <= free_gb < MIN_DISK_GB:
        status = "low-disk"
    elif bpy_version is None:
        status = "not-installed"
    elif not bpy_version.startswith(args.expect):
        status = "version-mismatch"
    else:
        status = "ready"

    report = {
        "status": status,
        "ok": status == "ready",
        "target": target,
        "platform": f"{platform.system()}/{platform.machine()}",
        "support": {"supported": supported, "reason": support_reason},
        "python": {
            "version": platform.python_version(),
            "expected": f"{EXPECTED_PY[0]}.{EXPECTED_PY[1]}.*",
            "ok": py_ok,
            "executable": sys.executable,
        },
        "disk": {"free_gb": round(free_gb, 2), "min_gb": MIN_DISK_GB},
        "bpy": {"importable": bpy_version is not None, "version": bpy_version, "expected": args.expect, "error": bpy_error},
        "blender_cli": {"found": False, "path": None, "version": None} if args.no_blender else blender_cli(),
        "install": {
            "tool": "python_runtime",
            "args": {"action": "install", "packages": [f"bpy=={args.expect}"]},
            "size_mb": 403,
            "installed_mb": 883,
        },
        "notes": [
            "bpy is GPL-3.0; it is user-installed, never shipped by the plugin.",
            "bpy 5.2.x requires CPython ==3.13.* and a manylinux_2_28 wheel.",
            "If bpy is unavailable, render_studio.py also runs under `blender -b -P` (4.5/5.2 LTS).",
        ],
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"status: {status}")
        print(f"platform: {report['platform']} -> {target} ({support_reason})")
        print(f"python: {report['python']['version']} (expected {report['python']['expected']})")
        print(f"bpy: {bpy_version or 'not importable'}" + (f" ({bpy_error})" if bpy_error else ""))
        print(f"blender CLI: {report['blender_cli'].get('version') or 'not found'}")
        print(f"disk free: {free_gb:.1f} GB (need {MIN_DISK_GB} GB to install)")
        if status == "not-installed":
            print('install with: python_runtime action=install packages:["bpy==5.2.3"]')
        elif status == "unsupported" or status == "unsupported-python":
            print("this platform/python cannot install bpy 5.2.3; use OpenSCAD or a Blender CLI build")
        elif status == "version-mismatch":
            print(f"bpy {bpy_version} is importable, but the tested version is {args.expect}; render may still work")

    if args.require_ready and status != "ready":
        return 10
    return 0


if __name__ == "__main__":
    sys.exit(main())
