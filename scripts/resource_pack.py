"""Inventory, pack, verify and safely import fixed-version local website resources."""

import argparse
import gzip
import io
import json
import sys
import tarfile
import tempfile
from pathlib import Path

# CLI 与后端发布器共用清单契约；模块只依赖标准库，无需初始化 Django。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from atlas.resource_manifest import (
    RESOURCE_DIRS,
    canonical,
    sha,
    validate_manifest,
)


def inventory(source):
    paths = [source / "favicon.svg"]
    for name in RESOURCE_DIRS:
        directory = source / name
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError(f"Missing resource directory: {directory}")
        for path in directory.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Resource symlinks are not supported: {path}")
            if path.is_file():
                paths.append(path)
    records = []
    # 固定清单按相对路径字符串排序；Path 的分段排序会改变同名前缀文件与目录的顺序。
    for path in sorted(paths, key=lambda value: value.relative_to(source).as_posix()):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing resource file: {path}")
        content = path.read_bytes()
        records.append({"path": path.relative_to(source).as_posix(), "bytes": len(content), "sha256": sha(content)})
    return {"schema_version": 1, "version": "atlas-assets-" + sha(canonical(records))[:24],
            "rights_status": "unreviewed", "files": records}


def verify(source, manifest):
    actual = inventory(source)
    if actual["files"] != manifest["files"] or actual["version"] != manifest["version"]:
        expected = {r["path"]: r for r in manifest["files"]}
        actual_files = {r["path"]: r for r in actual["files"]}
        differences = [key for key in sorted(expected.keys() | actual_files.keys())
                       if expected.get(key) != actual_files.get(key)]
        raise ValueError("Missing, unexpected or corrupt resources: " + ", ".join(differences[:10]))


def pack(source, manifest, output):
    verify(source, manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed, \
            tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        files = [("resource-pack.json", canonical(manifest))]
        files.extend((r["path"], None) for r in manifest["files"])
        for name, body in files:
            content = body if body is not None else (source / name).read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(content), 0o644, 0
            archive.addfile(info, io.BytesIO(content))


def install(package, manifest, destination):
    if destination.exists():
        raise ValueError("Resource destination already exists; verify it or choose a new directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    records = {record["path"]: record for record in manifest["files"]}
    expected = set(records) | {"resource-pack.json"}
    with tempfile.TemporaryDirectory(prefix=".resources-", dir=destination.parent) as tmp:
        staging = Path(tmp) / "content"
        staging.mkdir()
        seen = set()
        with tarfile.open(package, "r|gz") as archive:
            for member in archive:
                if not member.isfile() or member.name not in expected or member.name in seen:
                    raise ValueError(f"Unexpected, duplicate or unsafe archive entry: {member.name}")
                seen.add(member.name)
                maximum = len(canonical(manifest)) if member.name == "resource-pack.json" else records[member.name]["bytes"]
                if member.size != maximum:
                    raise ValueError(f"Unexpected resource size: {member.name}")
                content = archive.extractfile(member).read(maximum + 1)
                if len(content) != maximum:
                    raise ValueError(f"Truncated resource: {member.name}")
                if member.name == "resource-pack.json":
                    if content != canonical(manifest):
                        raise ValueError("Archive manifest does not match the reviewed manifest")
                    continue
                if sha(content) != records[member.name]["sha256"]:
                    raise ValueError(f"Resource checksum mismatch: {member.name}")
                path = staging / member.name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        if seen != expected:
            raise ValueError("Resource archive is incomplete")
        verify(staging, manifest)
        staging.rename(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inventory", "verify", "pack", "install"))
    parser.add_argument("--manifest", type=Path, default=Path("assets/resource-manifest.json"))
    parser.add_argument("--source", type=Path, default=Path("dist"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--package", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "inventory":
            manifest = inventory(args.source)
            with args.manifest.open("x") as output:
                json.dump(manifest, output, ensure_ascii=False, indent=2, sort_keys=True)
                output.write("\n")
        else:
            manifest = validate_manifest(json.loads(args.manifest.read_text()))
            if args.action == "verify":
                verify(args.source, manifest)
            elif args.action == "pack":
                if not args.output:
                    parser.error("pack requires --output")
                pack(args.source, manifest, args.output)
            else:
                if not args.package:
                    parser.error("install requires --package")
                destination = args.output or Path("assets/local") / manifest["version"]
                install(args.package, manifest, destination)
        print(json.dumps({"version": manifest["version"], "files": len(manifest["files"]),
                          "bytes": sum(r["bytes"] for r in manifest["files"]),
                          "rights_status": manifest["rights_status"]}))
    except (OSError, ValueError, tarfile.TarError) as exc:
        parser.exit(1, f"Resource package error: {exc}\n")


if __name__ == "__main__":
    main()
