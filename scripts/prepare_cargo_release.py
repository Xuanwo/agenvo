#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inject a release version into Cargo workspace manifests."
    )
    parser.add_argument("--version", required=True, help="Release version to inject")
    return parser.parse_args()


def replace_once(content: str, pattern: str, replacement: str, label: str) -> str:
    content, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
    if count != 1:
        raise RuntimeError(f"expected exactly one {label} entry, found {count}")
    return content


def main() -> None:
    args = parse_args()
    workspace_manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
    content = workspace_manifest.read_text(encoding="utf-8")
    content = replace_once(
        content,
        r'^version = "[^"]+"$',
        f'version = "{args.version}"',
        "workspace version",
    )
    content = replace_once(
        content,
        r'^agenvo-core = \{ version = "=[^"]+", path = "agenvo-core" \}$',
        f'agenvo-core = {{ version = "={args.version}", path = "agenvo-core" }}',
        "workspace dependency version",
    )
    workspace_manifest.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
