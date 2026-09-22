import copy
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from resource_pack import (
    canonical,
    install,
    inventory,
    pack,
    sha,
    validate_manifest,
    verify,
)


class ResourcePackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        for directory in ("assets", "avatars", "illustrations"):
            path = self.source / directory
            path.mkdir(parents=True)
            (path / "fixture.txt").write_text(f"Fixture {directory}")
        (self.source / "favicon.svg").write_text("<svg/>")
        self.manifest = inventory(self.source)

    def test_deterministic_pack_and_complete_restore(self):
        first, second = self.root / "first.tar.gz", self.root / "second.tar.gz"
        pack(self.source, self.manifest, first)
        pack(self.source, self.manifest, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        destination = self.root / "restored"
        install(first, self.manifest, destination)
        verify(destination, self.manifest)
        with self.assertRaisesRegex(ValueError, "already exists"):
            install(first, self.manifest, destination)

    def test_pack_and_restore_follow_manifest_relative_path_order(self):
        (self.source / "assets/emblems").mkdir()
        (self.source / "assets/emblems.json").write_text("{}")
        (self.source / "assets/emblems/babel.png").write_bytes(b"fixture image")
        # 与素材生成器的字符串顺序一致；Path 排序会把目录内文件放到 emblems.json 前。
        names = ("assets/emblems.json", "assets/emblems/babel.png", "assets/fixture.txt",
                 "avatars/fixture.txt", "favicon.svg", "illustrations/fixture.txt")
        records = []
        for name in names:
            content = (self.source / name).read_bytes()
            records.append({"path": name, "bytes": len(content), "sha256": sha(content)})
        manifest = {"schema_version": 1, "version": "atlas-assets-" + sha(canonical(records))[:24],
                    "rights_status": "unreviewed", "files": records}
        validate_manifest(manifest)
        self.assertEqual(inventory(self.source), manifest)
        package, destination = self.root / "ordered.tar.gz", self.root / "restored"
        pack(self.source, manifest, package)
        install(package, manifest, destination)
        verify(destination, manifest)

    def test_missing_or_corrupt_resources_fail(self):
        (self.source / "avatars/fixture.txt").write_text("corrupt")
        with self.assertRaisesRegex(ValueError, "corrupt resources"):
            verify(self.source, self.manifest)
        (self.source / "avatars/fixture.txt").unlink()
        with self.assertRaisesRegex(ValueError, "corrupt resources"):
            verify(self.source, self.manifest)

    def test_archive_rejects_traversal_links_and_incomplete_input_atomically(self):
        for index, name in enumerate(("../outside.txt", "/absolute.txt", "avatars/fixture.txt", "resource-pack.json")):
            package = self.root / f"malicious-{index}.tar.gz"
            with tarfile.open(package, "w:gz") as archive:
                item = tarfile.TarInfo(name)
                if name == "avatars/fixture.txt":
                    item.type, item.linkname = tarfile.SYMTYPE, "../../outside"
                    archive.addfile(item)
                elif name == "resource-pack.json":
                    content = canonical(self.manifest)
                    item.size = len(content)
                    archive.addfile(item, io.BytesIO(content))
                else:
                    archive.addfile(item, io.BytesIO(b""))
            destination = self.root / f"result-{index}"
            with self.subTest(name=name), self.assertRaises(ValueError):
                install(package, self.manifest, destination)
            self.assertFalse(destination.exists())
        self.assertFalse((self.root / "outside.txt").exists())

    def test_inventory_version_and_manifest_are_validated(self):
        validate_manifest(self.manifest)
        for field, value in (("version", "unrelated"), ("schema_version", True), ("files", [])):
            broken = copy.deepcopy(self.manifest)
            broken[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_manifest(broken)


if __name__ == "__main__":
    unittest.main()
