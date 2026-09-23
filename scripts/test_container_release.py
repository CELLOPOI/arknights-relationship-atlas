import json
import tempfile
import unittest
from pathlib import Path

from container_release import FILES, create, record


class ContainerReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / "release"
        for name in FILES.values():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"version": "fixed-assets"}))
        for service, digest in (("api", "a"), ("web", "b")):
            (self.root / f"{service}.json").write_text(json.dumps({
                "service": service, "digest": "sha256:" + digest * 64, "git_commit": "c" * 40,
            }))

    def build(self):
        return create(self.root, self.root, self.output, "Example/Atlas", "c" * 40)

    def test_manifest_pins_both_digests_and_only_packages_public_contract_files(self):
        (self.root / ".env").write_text("PRIVATE=must-not-publish")
        manifest = self.build()
        self.assertEqual(manifest["images"]["api"]["reference"], "ghcr.io/example/atlas-api@sha256:" + "a" * 64)
        self.assertEqual({path.name for path in self.output.iterdir()}, {*FILES, "release.json", "SHA256SUMS"})
        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, record(self.output / name)["sha256"])

    def test_rejects_mixed_build_commits_before_creating_output(self):
        path = self.root / "web.json"
        value = json.loads(path.read_text())
        value["git_commit"] = "d" * 40
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_mutable_image_tag(self):
        path = self.root / "api.json"
        value = json.loads(path.read_text())
        value["digest"] = "latest"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.build()

    def test_cannot_overwrite_an_existing_release(self):
        self.build()
        with self.assertRaises(FileExistsError):
            self.build()
