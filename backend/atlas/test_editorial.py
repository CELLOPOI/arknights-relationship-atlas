import copy
import io
import json
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import close_old_connections, connection
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from .candidate_admin import RecordForm
from .candidate_models import Candidate
from .candidate_services import create_candidate, export_candidate, save_candidate
from .editorial_models import ChangeSet
from .editorial_services import (
    add_record,
    adopt_candidate,
    create_change_set,
    edit_change_set,
    export_release,
    preview_publication,
    publish_change_set,
    rebase_change_set,
    remove_record,
    save_record,
    transition,
)
from .feedback_models import Feedback
from .feedback_services import review_feedback
from .models import Evidence, Person, Relationship, User
from .release_models import DataRelease, ReleaseState
from .resource_manifest import canonical, sha
from .source_data import export_database
from .test_releasing import TEST_ASSET_MANIFEST, legacy_fixture, package_for, publish


def make_batch(actor, title="资料修订", **kwargs):
    return create_change_set(actor=actor, title=title, description="核对原始剧情并修正资料。", **kwargs)


def add(batch, actor, section="people", record_id="char_a", new_id=""):
    batch.refresh_from_db()
    return add_record(batch.pk, actor=actor, expected_version=batch.version,
                      section=section, record_id=record_id, new_id=new_id)


def save(item, actor, **fields):
    item.refresh_from_db()
    item.change_set.refresh_from_db()
    return save_record(item.pk, actor=actor, expected_version=item.version,
                       expected_change_set_version=item.change_set.version,
                       proposed={**item.proposed, **fields}, private_note="private-editor-note")


def act(batch, actor, action, **kwargs):
    batch.refresh_from_db()
    return transition(batch.pk, actor=actor, expected_version=batch.version, action=action, **kwargs)


def approve(batch, actor):
    act(batch, actor, "submit")
    return act(batch, actor, "approve", note="已核对方向与原文依据。")


def release(batch, actor):
    batch.refresh_from_db()
    preview = preview_publication(batch.pk, actor=actor, expected_version=batch.version)
    return publish_change_set(batch.pk, actor=actor, expected_version=batch.version, preview_token=preview["token"])


@override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST)
class EditorialTests(TestCase):
    def setUp(self):
        legacy_fixture()
        publish(package_for(export_database()))
        self.actor = User.objects.create_superuser("maintainer", "maintainer@example.test", "Test-password-4291!")

    def changed_batch(self, **kwargs):
        batch = make_batch(self.actor, **kwargs)
        item = add(batch, self.actor)
        save(item, self.actor, name="修正后的姓名")
        return batch

    def test_linked_new_records_review_publish_export_and_rollback(self):
        feedback = Feedback.objects.create(type="addition", description="private-feedback-body", contact="private-contact")
        batch = make_batch(self.actor, feedback_id=feedback.pk)
        faction = add(batch, self.actor, "factions", "", "new_faction")
        save(faction, self.actor, name="新阵营")
        person = add(batch, self.actor, "people", "", "npc_new")
        save(person, self.actor, name="新人物", faction_id="new_faction")
        identity = add(batch, self.actor, "identities", "", "char_new")
        save(identity, self.actor, person_id="npc_new", label="新形态")
        relation = add(batch, self.actor, "relationships", "", "rel_new")
        # 关联草稿可分步保存；完整证据要求在提交审核时检查。
        save(relation, self.actor, person_a_id="npc_new", person_b_id="char_a",
             kind="awareness", awareness_from_id="npc_new")
        with self.assertRaisesMessage(ValidationError, "independent evidence"):
            act(batch, self.actor, "submit")
        evidence = add(batch, self.actor, "evidence", "", "evidence_new")
        save(evidence, self.actor, relationship_id="rel_new", quote=" 原文\n第二行 ",
             sources=[{"kind": "story", "source": "story/new.txt", "line": 2, "endLine": 5, "version": "source-v1"}])
        self.assertFalse(Person.objects.filter(pk="npc_new").exists())
        approve(batch, self.actor)
        published = release(batch, self.actor)
        self.assertEqual(published.origin, "editorial")
        self.assertEqual(Relationship.objects.get(pk="rel_new").awareness_from_id, "npc_new")
        self.assertEqual(Evidence.objects.get(source_id="evidence_new").quote, " 原文\n第二行 ")
        feedback.refresh_from_db()
        self.assertEqual(feedback.status, "resolved")
        self.assertIn(published.pk, feedback.review_note)
        self.assertEqual(ReleaseState.objects.get(pk=1).authority, "database")
        self.assertEqual(self.client.get("/api/graph/?scope=all").json()["dataRelease"]["origin"], "editorial")
        archive = export_release(published)
        self.assertEqual(archive, export_release(published))
        with zipfile.ZipFile(io.BytesIO(archive)) as output:
            exported = "\n".join(output.read(name).decode() for name in output.namelist())
            for value in ("private-feedback-body", "private-contact", "private-editor-note", self.actor.email,
                          "已核对方向与原文依据"):
                self.assertNotIn(value, exported)
            self.assertEqual(json.loads(output.read("manifest.json"))["metadata"]["release_id"], published.pk)
        rollback = make_batch(self.actor, title="撤销新增资料", rollback_target_id="test-1")
        approve(rollback, self.actor)
        restored = release(rollback, self.actor)
        self.assertEqual(restored.origin, "rollback")
        self.assertEqual(restored.previous_id, published.pk)
        self.assertFalse(Person.objects.get(pk="npc_new").published)
        self.assertFalse(Relationship.objects.get(pk="rel_new").published)
        self.assertFalse(Evidence.objects.get(source_id="evidence_new").published)
        self.assertTrue(Feedback.objects.filter(pk=feedback.pk).exists())
        self.assertTrue(User.objects.filter(pk=self.actor.pk).exists())

    def test_review_freezes_records_and_withdrawal_invalidates_preview(self):
        batch = self.changed_batch()
        item = batch.records.get()
        approved = approve(batch, self.actor)
        preview = preview_publication(batch.pk, actor=self.actor, expected_version=approved.version)
        with self.assertRaisesMessage(ValidationError, "只有草稿"):
            save(item, self.actor, name="审核后暗改")
        with self.assertRaisesMessage(ValidationError, "所属修订"):
            save_candidate(item.pk, actor=self.actor, expected_version=item.version,
                           proposed=item.proposed, private_note="")
        act(batch, self.actor, "withdraw", note="需要补充说明")
        save(item, self.actor, name="修改后的第二版")
        approve(batch, self.actor)
        batch.refresh_from_db()
        with self.assertRaisesMessage(ValidationError, "重新预览"):
            publish_change_set(batch.pk, actor=self.actor, expected_version=batch.version, preview_token=preview["token"])
        release(batch, self.actor)
        self.assertEqual(Person.objects.get(pk="char_a").name, "修改后的第二版")

    def test_editor_and_feedback_handler_cannot_approve_or_publish(self):
        editor = User.objects.create_user("editor", "editor@example.test", "Test-password-1234!", is_staff=True)
        editor.user_permissions.add(*Permission.objects.filter(codename__in=(
            "view_changeset", "add_changeset", "change_changeset", "add_candidate", "change_candidate", "view_candidate")))
        batch = make_batch(editor)
        save(add(batch, editor), editor, name="编辑修改")
        act(batch, editor, "submit")
        with self.assertRaises(PermissionDenied):
            act(batch, editor, "approve", note="审核")
        with self.assertRaises(PermissionDenied):
            preview_publication(batch.pk, actor=editor, expected_version=batch.version)
        handler = User.objects.create_user("handler", "handler@example.test", "Test-password-1234!", is_staff=True)
        handler.user_permissions.add(Permission.objects.get(codename="change_feedback"))
        with self.assertRaises(PermissionDenied):
            make_batch(handler)
        self.client.force_login(handler)
        self.assertEqual(self.client.get(f"/admin/atlas/changeset/{batch.pk}/change/").status_code, 403)

    def test_rebase_preserves_unrelated_updates_and_requires_conflict_resolution(self):
        batch = self.changed_batch()
        data = export_database()
        data["people"][1]["name"] = "另一人物更新"
        publish(package_for(data, "test-2", "test-1"))
        with self.assertRaisesMessage(ValidationError, "新版本"):
            act(batch, self.actor, "submit")
        batch.refresh_from_db()
        rebase_change_set(batch.pk, actor=self.actor, expected_version=batch.version)
        approve(batch, self.actor)
        release(batch, self.actor)
        self.assertEqual(Person.objects.get(pk="char_b").name, "另一人物更新")
        stale = self.changed_batch()
        winner = self.changed_batch(title="其他修订")
        save(winner.records.get(), self.actor, name="先发布的修改")
        approve(winner, self.actor)
        release(winner, self.actor)
        stale.refresh_from_db()
        with self.assertRaisesMessage(ValidationError, "已被其他发布修改"):
            rebase_change_set(stale.pk, actor=self.actor, expected_version=stale.version)

    def test_feedback_failure_rolls_back_data_release_and_audit(self):
        feedback = Feedback.objects.create(type="data_error", description="test")
        batch = self.changed_batch(feedback_id=feedback.pk)
        approve(batch, self.actor)
        before = export_database()
        with (patch("atlas.editorial_services.review_feedback", side_effect=ValidationError("Feedback changed")),
              self.assertRaises(ValidationError)):
            release(batch, self.actor)
        self.assertEqual(export_database(), before)
        self.assertEqual(DataRelease.objects.count(), 1)
        batch.refresh_from_db()
        self.assertEqual(batch.status, "approved")
        self.assertFalse(batch.events.filter(action="published").exists())

    def test_legacy_git_packages_cannot_overwrite_database_authority(self):
        batch = self.changed_batch()
        approve(batch, self.actor)
        current = release(batch, self.actor)
        with self.assertRaisesMessage(ValidationError, "后台管理"):
            publish(package_for(export_database(), "git-after-editorial", current.pk))
        self.assertEqual(ReleaseState.objects.get(pk=1).current_id, current.pk)

    def test_feedback_change_after_preview_requires_another_preview(self):
        feedback = Feedback.objects.create(type="data_error", description="test")
        batch = self.changed_batch(feedback_id=feedback.pk)
        batch = approve(batch, self.actor)
        preview = preview_publication(batch.pk, actor=self.actor, expected_version=batch.version)
        review_feedback(feedback.pk, actor=self.actor, expected_version=1, status="rejected",
                        review_note="补充核查后暂不采纳。", issue_url="")
        with self.assertRaisesMessage(ValidationError, "重新预览"):
            publish_change_set(batch.pk, actor=self.actor, expected_version=batch.version, preview_token=preview["token"])
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")
        updated = preview_publication(batch.pk, actor=self.actor, expected_version=batch.version)
        self.assertEqual(updated["feedback"]["status"], "不采纳")

    def test_resource_upgrade_can_be_reviewed_without_republishing_old_source_files(self):
        manifest = json.loads(TEST_ASSET_MANIFEST.read_text())
        manifest["files"][0]["sha256"] = "b" * 64
        manifest["version"] = "atlas-assets-" + sha(canonical(manifest["files"]))[:24]
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "resources.json"
            file.write_text(json.dumps(manifest))
            with override_settings(ASSET_MANIFEST_PATH=file):
                batch = make_batch(self.actor, title="更新素材版本")
                approve(batch, self.actor)
                published = release(batch, self.actor)
        self.assertEqual(published.manifest["asset_version"], manifest["version"])
        self.assertEqual(published.changes, [])
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")

    def test_removed_conflicting_record_restarts_from_latest_baseline(self):
        batch = self.changed_batch()
        item = batch.records.get()
        data = export_database()
        data["people"][0]["name"] = "最新正式姓名"
        publish(package_for(data, "test-2", "test-1"))
        batch.refresh_from_db()
        remove_record(batch.pk, actor=self.actor, expected_version=batch.version, candidate_id=item.pk)
        batch.refresh_from_db()
        rebase_change_set(batch.pk, actor=self.actor, expected_version=batch.version)
        restored = add(batch, self.actor)
        self.assertEqual(restored.proposed["name"], "最新正式姓名")
        self.assertEqual(restored.before["name"], "最新正式姓名")
        self.assertGreater(restored.edits.count(), 1)

    def test_stale_versions_drift_and_invalid_references_fail_closed(self):
        batch = self.changed_batch()
        item = batch.records.get()
        old_version = item.version
        save(item, self.actor, name="更新")
        item.change_set.refresh_from_db()
        with self.assertRaisesMessage(ValidationError, "其他维护者"):
            save_record(item.pk, actor=self.actor, expected_version=old_version,
                        expected_change_set_version=item.change_set.version,
                        proposed=item.proposed, private_note="")
        with self.assertRaisesMessage(ValidationError, "关联资料"):
            save(item, self.actor, faction_id="missing")
        Person.objects.filter(pk="char_a").update(name="漂移")
        with self.assertRaisesMessage(ValidationError, "数据漂移"):
            act(batch, self.actor, "submit")

    def test_asset_validation_noop_and_empty_drafts_block_review(self):
        batch = make_batch(self.actor)
        add(batch, self.actor)
        with self.assertRaisesMessage(ValidationError, "没有资料变化"):
            act(batch, self.actor, "submit")
        item = batch.records.get()
        save(item, self.actor, avatar="/avatars/not-in-package.webp")
        with self.assertRaisesMessage(ValidationError, "absent"):
            act(batch, self.actor, "submit")
        batch.refresh_from_db()
        remove_record(batch.pk, actor=self.actor, expected_version=batch.version, candidate_id=item.pk)
        blank = add(batch, self.actor, "people", "", "npc_blank")
        with self.assertRaises(ValidationError):
            act(batch, self.actor, "submit")
        self.assertTrue(Candidate.objects.filter(pk=blank.pk).exists())

    def test_existing_candidate_can_be_adopted_with_history(self):
        current = ReleaseState.objects.get(pk=1).current
        item = create_candidate(actor=self.actor, section="people", record_id="char_a",
                                expected_release=current.pk, expected_digest=current.manifest["data_digest"])
        original = copy.deepcopy(item.proposed)
        batch = adopt_candidate(item.pk, actor=self.actor, expected_version=item.version)
        self.assertEqual(batch.records.get().proposed, original)
        self.assertEqual(item.edits.count(), 1)
        with self.assertRaisesMessage(ValidationError, "关联资料"):
            export_candidate(item.pk, actor=self.actor, expected_version=item.version)
        save(item, self.actor, name="采纳旧候选")
        batch.refresh_from_db()
        edit_change_set(batch.pk, actor=self.actor, expected_version=batch.version,
                        title=batch.title, description="复核已有候选和原文依据。")
        approve(batch, self.actor)
        release(batch, self.actor)

    def test_admin_forms_review_publish_and_export_are_csrf_protected(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.force_login(self.actor)
        batch = self.changed_batch()
        path = f"/admin/atlas/changeset/{batch.pk}/change/"
        response = self.client.get(path)
        self.assertContains(response, "修正后的姓名")
        token = response.cookies["csrftoken"].value
        batch.refresh_from_db()
        payload = {"action": "submit", "version_token": batch.version}
        self.assertEqual(self.client.post(path, payload).status_code, 403)
        self.assertEqual(self.client.post(path, payload, HTTP_X_CSRFTOKEN=token).status_code, 302)
        batch.refresh_from_db()
        self.assertEqual(self.client.post(path, {"action": "approve", "version_token": batch.version, "note": "已审读原文"},
                                         HTTP_X_CSRFTOKEN=token).status_code, 302)
        batch.refresh_from_db()
        response = self.client.post(path, {"action": "preview", "version_token": batch.version}, HTTP_X_CSRFTOKEN=token)
        self.assertContains(response, "确认发布此版本")
        self.assertEqual(self.client.post(path, {"action": "publish", "version_token": batch.version,
            "preview_token": response.context["preview"]["token"]}, HTTP_X_CSRFTOKEN=token).status_code, 302)
        batch.refresh_from_db()
        release_path = f"/admin/atlas/datarelease/{batch.published_release_id}/"
        self.assertContains(self.client.get(release_path+"change/"), "导出此版本资料快照")
        self.assertEqual(self.client.post(release_path+"export/").status_code, 403)
        self.assertEqual(self.client.post(release_path+"export/", HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_group_record_form_uses_other_new_records_and_version(self):
        batch = make_batch(self.actor)
        person = add(batch, self.actor, "people", "", "npc_draft")
        save(person, self.actor, name="草稿人物", faction_id="rhodes")
        relation = add(batch, self.actor, "relationships", "", "rel_draft")
        form = RecordForm(candidate=relation)
        self.assertIn("npc_draft", dict(form.fields["record_person_a_id"].choices))
        self.assertFalse(form.fields["record_person_a_id"].disabled)
        self.assertTrue(form.initial["change_set_version"])
        self.client.force_login(self.actor)
        self.assertContains(self.client.get(f"/admin/atlas/candidate/{relation.pk}/change/"), "返回修订")

    def test_large_release_differences_are_paginated_without_losing_records(self):
        data = export_database()
        for index in range(26):
            data["people"].append({**data["people"][0], "id": f"npc_{index:03}", "name": f"新增人物 {index}"})
        publish(package_for(data, "large-publication", "test-1"))
        self.client.force_login(self.actor)
        first = self.client.get("/admin/atlas/datarelease/large-publication/change/")
        second = self.client.get("/admin/atlas/datarelease/large-publication/change/?page=2")
        self.assertEqual(len(first.context["changes"]), 25)
        self.assertEqual(len(second.context["changes"]), 1)
        self.assertContains(first, "共 26 条差异")
        self.assertContains(second, "新增人物 25")


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locks")
@override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST)
class EditorialConcurrencyTests(TransactionTestCase):
    def setUp(self):
        legacy_fixture()
        publish(package_for(export_database()))
        self.actor = User.objects.create_superuser("publisher", "publisher@example.test", "Test-password-1234!")

    def test_two_publishers_cannot_apply_overlapping_baselines(self):
        jobs = []
        for index in range(2):
            batch = make_batch(self.actor, title=f"修订 {index}")
            save(add(batch, self.actor), self.actor, name=f"修订姓名 {index}")
            batch = approve(batch, self.actor)
            preview = preview_publication(batch.pk, actor=self.actor, expected_version=batch.version)
            jobs.append((batch.pk, batch.version, preview["token"]))
        barrier = Barrier(2)

        def worker(job):
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.actor.pk)
                barrier.wait(timeout=10)
                publish_change_set(job[0], actor=actor, expected_version=job[1], preview_token=job[2])
                return "published"
            except ValidationError:
                return "stale"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(worker, jobs)), ["published", "stale"])
        self.assertEqual(DataRelease.objects.count(), 2)
        self.assertEqual(ChangeSet.objects.filter(status="published").count(), 1)

    def test_concurrent_record_edits_share_revision_version(self):
        batch = make_batch(self.actor)
        item = add(batch, self.actor)
        batch.refresh_from_db()
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.actor.pk)
                barrier.wait(timeout=10)
                save_record(item.pk, actor=actor, expected_version=item.version,
                    expected_change_set_version=batch.version, proposed={**item.proposed, "name": f"新姓名 {index}"},
                    private_note="")
                return "saved"
            except ValidationError:
                return "stale"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(worker, range(2))), ["saved", "stale"])
        self.assertEqual(item.edits.count(), 2)
