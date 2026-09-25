import copy
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import close_old_connections, connection, connections
from django.test import RequestFactory, SimpleTestCase, TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from .importing import import_bundle
from .management.commands.build_data_release import source_matches_commit
from .models import Evidence, Faction, Feedback, Identity, Person, Relationship, Submission, User
from .release_models import DataRelease, ReleaseState
from .releasing import apply_release, build_package, prepare_rollback, preview_release, validate_package
from .services import review_submission
from .source_data import compile_source, export_database, read_json, write_source
from .tests import EVIDENCE, GRAPH

TEST_ASSET_MANIFEST = Path(__file__).parent / "fixtures/release-resources.json"
TEST_ASSET_VERSION = read_json(TEST_ASSET_MANIFEST)["version"]


def legacy_fixture():
    with override_settings(FORMAL_DATA_MANAGED=False):
        import_bundle(GRAPH, EVIDENCE)
    ReleaseState.objects.get_or_create(pk=1)


def package_for(data, version="test-1", previous=None):
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source"
        write_source(data, source, metadata={"origin": "test-fixture"})
        compiled = compile_source(source)
    return build_package(compiled, release_id=version, git_commit="a" * 40, expected_previous=previous,
                         asset_version=TEST_ASSET_VERSION, dirty=False)


@override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST)
def publish(package):
    preview = preview_release(package)
    return apply_release(package, preview["preview_token"])


@override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST)
class ReleaseTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        legacy_fixture()

    def test_first_adoption_preserves_formal_records_and_binds_stable_evidence_ids(self):
        before = export_database()
        package = package_for(before)
        preview = preview_release(package)
        self.assertEqual(preview["changes"], [])
        self.assertEqual(DataRelease.objects.count(), 0)
        self.assertFalse(apply_release(package, preview["preview_token"])["already_applied"])
        self.assertEqual(export_database(), before)
        self.assertEqual(ReleaseState.objects.get(pk=1).current_id, "test-1")
        self.assertTrue(all(e.source_id for e in Evidence.objects.all()))
        self.assertTrue(apply_release(package, preview["preview_token"])["already_applied"])
        self.assertTrue(preview_release(package)["already_applied"])
        self.assertEqual(DataRelease.objects.count(), 1)

    def test_public_graph_exposes_version_and_revalidates_cache(self):
        data = export_database()
        publish(package_for(data))
        response = self.client.get("/api/graph/")
        self.assertEqual(response.json()["dataRelease"]["id"], "test-1")
        self.assertEqual(self.client.get("/api/graph/", HTTP_IF_NONE_MATCH=response["ETag"]).status_code, 304)
        data["people"][0]["name"] = "Published correction"
        publish(package_for(data, "test-2", "test-1"))
        updated = self.client.get("/api/graph/", HTTP_IF_NONE_MATCH=response["ETag"])
        self.assertEqual(updated.status_code, 200)
        self.assertNotEqual(updated["ETag"], response["ETag"])
        self.assertEqual(updated.json()["dataRelease"]["id"], "test-2")

    def test_legacy_manual_evidence_keeps_source_id_when_rebuilt_in_empty_database(self):
        legacy = Evidence.objects.create(
            pk=123456, relationship_id="char_a|char_b", quote="Legacy independent evidence",
            sources=[{"kind": "story", "source": "manual.txt", "line": 8, "endLine": 10}],
        )
        original_id = f"database:{legacy.pk}"
        original = export_database()
        self.assertIn(original_id, [row["id"] for row in original["evidence"]])
        package = package_for(original)
        # 清空测试库的正式表，保留迁移初始化的发布锁；重建不能依赖旧自增键。
        for model in (Evidence, Identity, Relationship, Person, Faction):
            model.objects.all().delete()
        publish(package)
        rebuilt = Evidence.objects.get(source_id=original_id)
        self.assertNotEqual(rebuilt.pk, legacy.pk)
        self.assertEqual(rebuilt.quote, legacy.quote)
        self.assertEqual(rebuilt.sources, legacy.sources)
        self.assertEqual(export_database(), original)
        self.assertTrue(publish(package)["already_applied"])

    def test_independent_evidence_and_identity_withdrawal_filters_every_public_field(self):
        original = export_database()
        original["identities"].append({
            "external_id": "independent_alias", "person_id": "char_a", "label": "Alternate identity", "published": True,
        })
        extra = {"id": "editor:independent", "relationship_id": "char_a|char_b", "quote": "Withdrawn quotation",
                 "sources": [{"kind": "story", "source": "withdrawn.txt", "line": 7}], "published": True}
        original["evidence"].append(extra)
        visible = next(row for row in original["evidence"]
                       if row["relationship_id"] == "char_a|char_b" and row["id"] != extra["id"])
        publish(package_for(original))
        self.assertEqual(self.client.get("/api/people/independent_alias/").status_code, 200)
        withdrawn = copy.deepcopy(original)
        withdrawn["identities"][-1]["published"] = False
        withdrawn["evidence"][-1]["published"] = False
        publish(package_for(withdrawn, "test-2", "test-1"))
        self.assertEqual(self.client.get("/api/people/independent_alias/").status_code, 404)
        self.assertEqual(self.client.get("/api/people/char_a/").status_code, 200)
        response = self.client.get("/api/relationships/char_a|char_b/")
        self.assertEqual(response.status_code, 200)
        detail = response.json()
        self.assertEqual(detail["quote"], visible["quote"])
        self.assertEqual(detail["sources"], visible["sources"])
        self.assertEqual([(row["quote"], row["sources"]) for row in detail["evidence"]],
                         [(visible["quote"], visible["sources"])])
        self.assertTrue(Evidence.objects.filter(source_id=extra["id"], published=False).exists())
        publish(package_for(original, "test-3", "test-2"))
        self.assertEqual(self.client.get("/api/people/independent_alias/").status_code, 200)
        restored = self.client.get("/api/relationships/char_a|char_b/").json()
        self.assertEqual(restored["quote"], visible["quote"] + "\n\n" + extra["quote"])
        self.assertEqual(restored["sources"], visible["sources"] + extra["sources"])
        self.assertEqual(len(restored["evidence"]), 2)

    def test_preview_binds_database_and_package(self):
        package = package_for(export_database())
        preview = preview_release(package)
        altered = copy.deepcopy(package)
        altered["manifest"]["asset_version"] = "changed-assets"
        with self.assertRaisesMessage(ValidationError, "changed after preview"):
            apply_release(altered, preview["preview_token"])
        Person.objects.filter(pk="char_a").update(name="A changed after preview")
        with self.assertRaisesMessage(ValidationError, "baseline changed"):
            apply_release(package, preview["preview_token"])
        with self.assertRaisesMessage(ValidationError, "Invalid or expired"):
            apply_release(package, preview["preview_token"] + "changed")
        self.assertEqual(DataRelease.objects.count(), 0)

    def test_repeated_or_new_release_detects_database_drift(self):
        package = package_for(export_database())
        preview = preview_release(package)
        apply_release(package, preview["preview_token"])
        Evidence.objects.filter(relationship_id="char_a|char_b").update(quote="Unexpected database edit")
        for action in (lambda: preview_release(package), lambda: apply_release(package, preview["preview_token"])):
            with self.assertRaisesMessage(ValidationError, "drift"):
                action()
        self.assertEqual(DataRelease.objects.count(), 1)

    def test_withdraw_republish_and_revert_keep_feedback_and_accounts(self):
        initial = export_database()
        user = User.objects.create_user("existing", "existing@example.test", "Long-password-1234")
        feedback = Feedback.objects.create(type="other", description="Private feedback", contact="private contact")
        publish(package_for(initial))
        withdrawn = copy.deepcopy(initial)
        withdrawn["people"][0]["published"] = False
        withdrawn["relationships"][0]["published"] = False
        package = package_for(withdrawn, "test-2", "test-1")
        preview = preview_release(package)
        self.assertEqual([x["action"] for x in preview["changes"]], ["withdraw", "withdraw"])
        apply_release(package, preview["preview_token"])
        self.assertEqual(self.client.get("/api/people/char_a/").status_code, 404)
        self.assertEqual(self.client.get("/api/relationships/char_a|char_b/").status_code, 404)
        publish(package_for(initial, "test-3", "test-2"))
        self.assertEqual(self.client.get("/api/people/char_a/").status_code, 200)
        self.assertEqual(export_database(), initial)
        feedback.refresh_from_db()
        self.assertEqual(feedback.contact, "private contact")
        self.assertTrue(User.objects.filter(pk=user.pk).exists())
        self.assertEqual(DataRelease.objects.get(pk="test-3").previous_id, "test-2")

    def test_missing_files_and_stale_versions_are_rejected(self):
        initial = export_database()
        publish(package_for(initial))
        missing = copy.deepcopy(initial)
        missing["identities"].pop()
        with self.assertRaisesMessage(ValidationError, "Missing record: identities"):
            preview_release(package_for(missing, "test-2", "test-1"))
        with self.assertRaisesMessage(ValidationError, "Expected previous"):
            preview_release(package_for(initial, "test-2", None))
        with self.assertRaisesMessage(ValidationError, "already exists"):
            conflicting = package_for(initial)
            conflicting["manifest"]["asset_version"] = "other"
            preview_release(conflicting)

    def test_failed_application_rolls_back_records_and_release_state_together(self):
        initial = export_database()
        publish(package_for(initial))
        modified = copy.deepcopy(initial)
        modified["people"][0]["name"] = "Changed name"
        modified["evidence"][0]["quote"] = "Changed evidence"
        package = package_for(modified, "test-2", "test-1")
        preview = preview_release(package)
        with patch.object(DataRelease.objects, "create", side_effect=ValidationError("Injected failure")), \
                self.assertRaisesMessage(ValidationError, "Injected failure"):
            apply_release(package, preview["preview_token"])
        self.assertEqual(export_database(), initial)
        self.assertEqual(ReleaseState.objects.get(pk=1).current_id, "test-1")
        self.assertEqual(DataRelease.objects.count(), 1)

    def test_release_imports_identities_and_multiple_evidence_and_updates_versions(self):
        data = export_database()
        publish(package_for(data))
        old_version = Relationship.objects.get(pk="char_a|char_b").version
        data["identities"].append({"external_id": "alternate", "person_id": "char_a", "label": "Another identity", "published": True})
        data["evidence"].append({"id": "editor:new-evidence", "relationship_id": "char_a|char_b",
                                 "quote": "Independent quote", "sources": [], "published": True})
        publish(package_for(data, "test-2", "test-1"))
        self.assertEqual(self.client.get("/api/people/alternate/").json()["id"], "char_a")
        self.assertEqual(Evidence.objects.filter(relationship_id="char_a|char_b").count(), 2)
        self.assertEqual(Relationship.objects.get(pk="char_a|char_b").version, old_version + 1)

    def test_manifest_tampering_and_dirty_production_packages_are_rejected(self):
        package = package_for(export_database())
        broken = copy.deepcopy(package)
        broken["data"]["people"][0]["name"] = "Unrecorded edit"
        with self.assertRaisesMessage(ValidationError, "does not match"):
            validate_package(broken)
        package["manifest"]["working_tree_dirty"] = True
        preview = preview_release(package)
        with override_settings(DEBUG=False), self.assertRaisesMessage(ValidationError, "uncommitted work"):
            apply_release(package, preview["preview_token"])

    def test_manifest_rejects_boolean_counts_invalid_paths_and_unbound_file_hashes(self):
        original = package_for(export_database())
        modifications = [
            lambda m: m.update(schema_version=True),
            lambda m: m.update(counts={k: False for k in m["counts"]}),
            lambda m: m.update(metadata=[]),
            lambda m: m.update(files={"../../unexpected": "0" * 64}),
            lambda m: m["files"].update({next(iter(m["files"])): "0" * 64}),
            lambda m: m.update(source_path="../outside"),
        ]
        for index, modify in enumerate(modifications):
            package = copy.deepcopy(original)
            modify(package["manifest"])
            with self.subTest(index=index), self.assertRaises(ValidationError):
                validate_package(package)

    def test_rollback_of_additions_explicitly_withdraws_records_and_retains_ids(self):
        initial = export_database()
        publish(package_for(initial))
        expanded = copy.deepcopy(initial)
        expanded["people"].append({**expanded["people"][0], "id": "person_new", "name": "New person"})
        expanded["relationships"].append({**expanded["relationships"][0], "id": "new_relationship",
                                            "person_a_id": "char_a", "person_b_id": "person_new"})
        expanded["evidence"].extend([
            {**expanded["evidence"][0], "id": "new_relation_quote", "relationship_id": "new_relationship"},
            {**expanded["evidence"][0], "id": "additional_quote"},
        ])
        expanded["identities"].append({"external_id": "new_alias", "person_id": "char_a", "label": "New alias",
                                        "published": True})
        publish(package_for(expanded, "test-2", "test-1"))
        rolled_back = prepare_rollback(initial, expanded)
        package = package_for(rolled_back, "test-3", "test-2")
        preview = preview_release(package)
        self.assertEqual(sum(row["action"] == "withdraw" for row in preview["changes"]), 5)
        apply_release(package, preview["preview_token"])
        self.assertTrue(Person.objects.filter(pk="person_new", published=False).exists())
        self.assertTrue(Evidence.objects.filter(source_id="additional_quote", published=False).exists())
        self.assertEqual(self.client.get("/api/people/new_alias/").status_code, 404)
        evidence = self.client.get("/api/relationships/char_a|char_b/").json()["evidence"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(DataRelease.objects.count(), 3)

    def test_narrative_changes_are_previewed_without_creating_real_edges(self):
        data = export_database()
        contribution = {"title": "Example", "description": "Source context", "temporalScope": "Story",
                        "resultPath": "reviews/example.json", "directions": [
                            {"from": "char_a", "to": "char_b", "status": "supported", "evidenceIds": ["E1"]}
                        ], "citations": [], "sources": []}
        data["provenance"] = {"char_a|char_b": [contribution]}
        preview = preview_release(package_for(data))
        self.assertEqual(preview["changes"][0]["section"], "provenance")
        publish(package_for(data))
        data["provenance"]["char_a|char_b"][0]["description"] = "Updated source context"
        package = package_for(data, "test-2", "test-1")
        changes = preview_release(package)["changes"]
        self.assertEqual(changes[0]["action"], "update")
        publish(package)
        self.assertEqual(Relationship.objects.count(), 2)
        data["provenance"] = {}
        with self.assertRaisesMessage(ValidationError, "Missing narrative record"):
            preview_release(package_for(data, "test-3", "test-2"))

    def test_legacy_admin_import_evidence_and_submission_writes_are_closed(self):
        user = User.objects.create_superuser("editor", "editor@example.test", "Long-password-1234")
        submission = Submission.objects.create(author=user, person_id="char_a", body="Old submission", base_version=1)
        self.client.force_login(user)
        for model, key in ((Person, "char_a"), (Relationship, "char_a|char_b"),
                           (Evidence, Evidence.objects.first().pk), (Submission, submission.pk)):
            response = self.client.post(f"/admin/atlas/{model._meta.model_name}/{key}/change/", {})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.post("/admin/atlas/person/import/", {}).status_code, 403)
        with self.assertRaisesMessage(ValidationError, "旧导入入口已关闭"):
            import_bundle(GRAPH, EVIDENCE)
        with self.assertRaisesMessage(ValidationError, "旧投稿审核已停止"):
            review_submission(submission.pk, user, True)
        request = RequestFactory().get("/")
        request.user = user
        self.assertFalse(admin.site._registry[Evidence].has_add_permission(request))


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row locks require two database connections.")
@override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST)
class ReleaseConcurrencyTests(TransactionTestCase):
    def setUp(self):
        legacy_fixture()

    def test_concurrent_first_publish_has_one_winner(self):
        initial = export_database()
        first = package_for(initial, "first")
        second_data = copy.deepcopy(initial)
        second_data["people"][0]["name"] = "Concurrent edit"
        second = package_for(second_data, "second")
        previews = [preview_release(p)["preview_token"] for p in (first, second)]
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return apply_release((first, second)[index], previews[index])["release_id"]
            except ValidationError:
                return "rejected"
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(worker, i) for i in range(2)]
            results = [f.result(timeout=30) for f in futures]
        self.assertEqual(results.count("rejected"), 1)
        self.assertEqual(DataRelease.objects.count(), 1)
        winner = ReleaseState.objects.get(pk=1).current_id
        self.assertEqual(export_database(), DataRelease.objects.get(pk=winner).formal_snapshot)

    def test_graph_request_never_mixes_rows_across_publication(self):
        from . import views

        data = export_database()
        publish(package_for(data))
        from .public_cache import responses
        responses.clear()
        reached_nodes, continue_reading = Event(), Event()
        original = views.person_data

        def pause_after_people_query(person):
            if not reached_nodes.is_set():
                reached_nodes.set()
                if not continue_reading.wait(timeout=20):
                    raise RuntimeError("Timed out waiting for publication")
            return original(person)

        def read_graph():
            close_old_connections()
            try:
                return APIClient().get("/api/graph/?scope=all").json()
            finally:
                connections.close_all()

        with patch.object(views, "person_data", side_effect=pause_after_people_query), \
                ThreadPoolExecutor(max_workers=1) as pool:
            reading = pool.submit(read_graph)
            try:
                self.assertTrue(reached_nodes.wait(timeout=10))
                data["people"][0]["published"] = False
                publish(package_for(data, "test-2", "test-1"))
            finally:
                continue_reading.set()
            observed = reading.result(timeout=20)
        self.assertEqual((len(observed["nodes"]), len(observed["edges"])), (3, 2))
        self.assertEqual(observed["dataRelease"]["id"], "test-1")
        self.assertEqual(self.client.get("/api/graph/?scope=all").json()["dataRelease"]["id"], "test-2")


class ReleaseGitBindingTests(SimpleTestCase):
    def test_ignored_untracked_and_modified_sources_never_match_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "data/source"
            source.mkdir(parents=True)
            (root / ".gitignore").write_text("data/source/\n")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "add", ".gitignore"], cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit",
                            "-qm", "Test fixture"], cwd=root, check=True)
            (source / "manifest.json").write_text("{}\n")
            self.assertFalse(source_matches_commit(source, root, "HEAD"))
            subprocess.run(["git", "add", "-f", "data/source/manifest.json"], cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit",
                            "-qm", "Track fixture"], cwd=root, check=True)
            self.assertTrue(source_matches_commit(source, root, "HEAD"))
            (source / "manifest.json").write_text('{"changed":true}\n')
            self.assertFalse(source_matches_commit(source, root, "HEAD"))
