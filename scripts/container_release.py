"""Assemble a public, digest-pinned container release from CI build results."""

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

FILES = {
    "compose.yaml": "compose.yaml",
    "resource-manifest.json": "assets/resource-manifest.json",
    "preferences-manifest.json": "assets/preferences-manifest.json",
}
SERVICES = ("api", "web")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")
REPOSITORY = re.compile(r"[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_.-]*")


def record(path):
    contents = path.read_bytes()
    return {"bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}


def create(source, image_directory, output, repository, commit):
    repository = repository.lower()
    if not REPOSITORY.fullmatch(repository) or not COMMIT.fullmatch(commit):
        raise ValueError("Invalid repository or commit")
    images = {}
    for service in SERVICES:
        value = json.loads((image_directory / f"{service}.json").read_text())
        if (set(value) != {"service", "digest", "git_commit"} or value["service"] != service
                or value["git_commit"] != commit or not DIGEST.fullmatch(value["digest"])):
            raise ValueError("Image build identity mismatch")
        images[service] = {"reference": f'ghcr.io/{repository}-{service}@{value["digest"]}'}
    asset_version = json.loads((source / FILES["resource-manifest.json"]).read_text())["version"]
    if not isinstance(asset_version, str) or not re.fullmatch(r"[a-zA-Z0-9._-]+", asset_version):
        raise ValueError("Invalid asset version")
    output.mkdir(parents=True, exist_ok=False)
    for name, original in FILES.items():
        shutil.copyfile(source / original, output / name)
    manifest = {
        "schema_version": 1,
        "kind": "container-release",
        "repository": repository,
        "git_commit": commit,
        "platform": "linux/amd64",
        "asset_version": asset_version,
        "images": images,
        "files": {name: record(output / name) for name in FILES},
    }
    (output / "release.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (output / "SHA256SUMS").write_text("".join(
        f'{record(output / name)["sha256"]}  {name}\n' for name in sorted([*FILES, "release.json"])
    ))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--image-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    create(args.source, args.image_directory, args.output, args.repository, args.commit)


if __name__ == "__main__":
    main()
