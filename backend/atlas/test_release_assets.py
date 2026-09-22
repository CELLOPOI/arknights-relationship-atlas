import copy
import json
import tempfile
from pathlib import Path

from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings

from .release_assets import validate_release_assets
from .release_models import DataRelease
from .releasing import apply_release, preview_release
from .resource_manifest import canonical, sha
from .source_data import export_database
from .test_releasing import legacy_fixture, package_for


class ReleaseAssetTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        legacy_fixture()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "resource-manifest.json"
        self.data = export_database()
        names = sorted({row["avatar"].removeprefix("/") for row in self.data["people"] if row["avatar"]}
                       | {"assets/emblem.svg", "avatars/example.webp", "illustrations/example.webp", "favicon.svg"})
        files = [{"path": name, "bytes": 0, "sha256": sha(b"")} for name in names]
        self.manifest = {"schema_version": 1, "rights_status": "unreviewed", "files": files,
                         "version": "atlas-assets-" + sha(canonical(files))[:24]}
        self.path.write_text(json.dumps(self.manifest))
        self.package = package_for(self.data)
        self.package["manifest"]["asset_version"] = self.manifest["version"]

    def test_production_rejects_mismatch_before_preview_and_rechecks_before_apply(self):
        before = export_database()
        with override_settings(DEBUG=False, ASSET_MANIFEST_PATH=self.path):
            wrong = copy.deepcopy(self.package)
            wrong["manifest"]["asset_version"] = "different-assets"
            with self.assertRaisesMessage(ValidationError, "asset version"):
                preview_release(wrong)
            token = preview_release(self.package)["preview_token"]
            self.path.unlink()
            with self.assertRaisesMessage(ValidationError, "manifest is missing"):
                apply_release(self.package, token)
            self.assertEqual(export_database(), before)
            self.assertFalse(DataRelease.objects.exists())
            self.path.write_text(json.dumps(self.manifest))
            apply_release(self.package, token)
            self.assertEqual(DataRelease.objects.count(), 1)

    def test_missing_or_external_published_avatars_are_rejected(self):
        for avatar in ("/avatars/missing.webp", "https://example.test/avatar.webp"):
            package = copy.deepcopy(self.package)
            package["data"]["people"][0]["avatar"] = avatar
            with self.subTest(avatar=avatar), self.assertRaisesMessage(ValidationError, "avatars absent"):
                validate_release_assets(package, self.path)
            package["data"]["people"][0]["published"] = False
            validate_release_assets(package, self.path)
        for avatar in ("", "/avatars/unknown.svg"):
            package["data"]["people"][0].update(avatar=avatar, published=True)
            validate_release_assets(package, self.path)

    def test_invalid_resource_inventory_cannot_be_used_for_publication(self):
        self.manifest["files"].append(self.manifest["files"][0])
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaisesMessage(ValidationError, "manifest is missing or invalid"):
            validate_release_assets(self.package, self.path)
