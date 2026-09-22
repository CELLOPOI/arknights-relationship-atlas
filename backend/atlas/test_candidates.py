import copy
import io
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest import skipUnless

from django.contrib.auth.models import Permission
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .candidate_admin import RecordForm, SourceFormSet
from .candidate_models import Candidate, CandidateEdit
from .candidate_services import create_candidate, export_candidate, save_candidate
from .models import Evidence, Person, User
from .release_models import ReleaseState
from .source_data import export_database, source_filename
from .test_releasing import legacy_fixture, package_for, publish


def editor_user():
    user = User.objects.create_user("candidate_editor", "editor@example.test", "Atlas-editor-5938!", is_staff=True)
    user.user_permissions.add(*Permission.objects.filter(codename__in=("view_candidate", "add_candidate", "change_candidate")))
    return user


def start(user, section="people", record_id="char_a", relationship_id=""):
    release = ReleaseState.objects.get(pk=1).current
    return create_candidate(actor=user, section=section, record_id=record_id, relationship_id=relationship_id,
                            expected_release=release.pk, expected_digest=release.manifest["data_digest"])


class CandidateTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        legacy_fixture()
        publish(package_for(export_database()))
        cls.editor = editor_user()

    def test_every_record_kind_can_be_edited_without_writing_formal_data(self):
        before = export_database()
        cases = (("people", "char_a", "name", "候选姓名"), ("factions", "rhodes", "name", "候选阵营"),
                 ("identities", "char_a", "label", "候选身份"),
                 ("relationships", "char_a|char_b", "note", "候选判定说明"),
                 ("evidence", "import:char_a|char_b", "quote", "独立原文候选"))
        for section, key, field, value in cases:
            with self.subTest(section=section):
                item = start(self.editor, section, key)
                row = {**item.proposed, field: value}
                saved = save_candidate(item.pk, actor=self.editor, expected_version=1, proposed=row, private_note="私有备注")
                self.assertEqual(saved.version, 2)
                self.assertEqual(saved.proposed[field], value)
                self.assertEqual(item.edits.count(), 2)
        self.assertEqual(export_database(), before)

    def test_export_is_deterministic_complete_and_excludes_private_notes(self):
        item = start(self.editor)
        row = {**item.proposed, "name": "审查后的姓名"}
        item = save_candidate(item.pk, actor=self.editor, expected_version=1, proposed=row, private_note="绝不公开的联系方式")
        archive = export_candidate(item.pk, actor=self.editor, expected_version=2)
        self.assertEqual(archive, export_candidate(item.pk, actor=self.editor, expected_version=2))
        with zipfile.ZipFile(io.BytesIO(archive)) as file:
            path = "source/" + source_filename("people", "char_a")
            self.assertEqual(sorted(file.namelist()), sorted(["candidate-manifest.json", path]))
            manifest = json.loads(file.read("candidate-manifest.json"))
            self.assertEqual(manifest["base_release"], item.base_release_id)
            self.assertEqual(manifest["base_digest"], item.base_digest)
            self.assertEqual(manifest["candidate_version"], 2)
            self.assertEqual(json.loads(file.read(path)), row)
            self.assertNotIn("绝不公开", b"".join(file.read(name) for name in file.namelist()).decode())

    def test_new_independent_evidence_keeps_original_sources_and_stable_id(self):
        item = start(self.editor, "evidence", "", "char_a|char_b")
        self.assertIsNone(item.before)
        with self.assertRaises(ValidationError):
            export_candidate(item.pk, actor=self.editor, expected_version=1)
        sources = [{"kind": "story", "source": "原始出处.txt", "line": 3, "endLine": 7, "version": "rev-123"}]
        proposed = {**item.proposed, "quote": " 原文\n第二行。 ", "sources": sources}
        saved = save_candidate(item.pk, actor=self.editor, expected_version=1, proposed=proposed, private_note="")
        self.assertEqual(saved.proposed["sources"], sources)
        self.assertTrue(saved.record_id.startswith("evidence_"))
        self.assertEqual(Evidence.objects.count(), 2)
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")
        self.assertTrue(export_candidate(item.pk, actor=self.editor, expected_version=2))

    def test_source_form_roundtrip_preserves_quote_version_and_lines(self):
        item = start(self.editor, "evidence", "import:char_a|char_b")
        original = copy.deepcopy(item.proposed)
        form = RecordForm(candidate=item)
        payload = {key: value for key, value in form.initial.items() if value is not None}
        payload.update({"sources-TOTAL_FORMS": "3", "sources-INITIAL_FORMS": "1",
                        "sources-MIN_NUM_FORMS": "0", "sources-MAX_NUM_FORMS": "100",
                        "sources-1-kind": "", "sources-1-source": "", "sources-2-kind": "", "sources-2-source": ""})
        for key, value in original["sources"][0].items():
            payload[f"sources-0-{key}"] = value
        bound = RecordForm(payload, candidate=item)
        sources = SourceFormSet(payload, initial=original["sources"], prefix="sources")
        self.assertTrue(bound.is_valid(), bound.errors)
        self.assertTrue(sources.is_valid(), sources.errors)
        self.assertEqual(bound.proposal(sources), original)

    def test_stale_candidate_or_release_cannot_save_or_export(self):
        item = start(self.editor)
        row = {**item.proposed, "name": "候选一"}
        save_candidate(item.pk, actor=self.editor, expected_version=1, proposed=row, private_note="")
        with self.assertRaisesMessage(ValidationError, "其他维护者"):
            save_candidate(item.pk, actor=self.editor, expected_version=1, proposed={**row, "name": "旧页面"}, private_note="")
        with self.assertRaisesMessage(ValidationError, "版本已变化"):
            export_candidate(item.pk, actor=self.editor, expected_version=1)
        publish(package_for(export_database(), "test-2", "test-1"))
        with self.assertRaisesMessage(ValidationError, "发布新版本"):
            export_candidate(item.pk, actor=self.editor, expected_version=2)
        with self.assertRaisesMessage(ValidationError, "发布新版本"):
            save_candidate(item.pk, actor=self.editor, expected_version=2, proposed=row, private_note="")

    def test_browser_post_preserves_unedited_newlines_and_normalizes_real_text_edits(self):
        data = export_database()
        data["evidence"][0]["quote"] = " 原文第一行\n原文第二行 "
        data["relationships"][0]["note"] = "说明第一行\r\n说明第二行"
        publish(package_for(data, "test-newlines", "test-1"))
        formal = export_database()
        self.client.force_login(self.editor)
        cases = (("evidence", data["evidence"][0]["id"], "quote"),
                 ("relationships", data["relationships"][0]["id"], "note"))
        for section, record_id, key in cases:
            with self.subTest(section=section):
                item = start(self.editor, section, record_id)
                original = item.proposed[key]
                path = f"/admin/atlas/candidate/{item.pk}/change/"

                def post_text(text, item=item, key=key, section=section, path=path):
                    payload = {k: v for k, v in RecordForm(candidate=item).initial.items() if v is not None}
                    payload["record_" + key] = text
                    if section == "evidence":
                        sources = item.proposed["sources"]
                        payload.update({"sources-TOTAL_FORMS": str(len(sources)),
                                        "sources-INITIAL_FORMS": str(len(sources)),
                                        "sources-MIN_NUM_FORMS": "0", "sources-MAX_NUM_FORMS": "100"})
                        for index, source in enumerate(sources):
                            payload.update({f"sources-{index}-{name}": value for name, value in source.items()})
                    self.assertEqual(self.client.post(path, payload).status_code, 302)
                    item.refresh_from_db()

                browser_text = original.replace("\r\n", "\n").replace("\n", "\r\n")
                post_text(browser_text)
                self.assertEqual(item.proposed[key], original)
                self.assertEqual(self.client.get(path).context["changes"], [])
                post_text(browser_text + "\r\n真实新增文字")
                edited = original.replace("\r\n", "\n") + "\n真实新增文字"
                self.assertEqual(item.proposed[key], edited)
                change = next(row for row in self.client.get(path).context["changes"] if row["field"] == key)
                self.assertEqual(change["before"], original)
                self.assertEqual(change["after"], edited)
                post_text(edited.replace("\n", "\r\n"))
                self.assertEqual(item.proposed[key], edited)
                post_text(browser_text)
                self.assertEqual(item.proposed[key], original)
        self.assertEqual(export_database(), formal)

    def test_bad_reference_endpoint_change_and_database_drift_are_rejected(self):
        item = start(self.editor)
        with self.assertRaises(ValidationError):
            save_candidate(item.pk, actor=self.editor, expected_version=1,
                           proposed={**item.proposed, "faction_id": "missing"}, private_note="")
        relation = start(self.editor, "relationships", "char_a|char_b")
        with self.assertRaises(ValidationError):
            save_candidate(relation.pk, actor=self.editor, expected_version=1,
                           proposed={**relation.proposed, "person_b_id": "person_c"}, private_note="")
        Person.objects.filter(pk="char_a").update(name="未受控修改")
        with self.assertRaisesMessage(ValidationError, "数据漂移"):
            export_candidate(item.pk, actor=self.editor, expected_version=1)

    def test_feedback_only_staff_cannot_read_create_change_or_export_candidates(self):
        handler = User.objects.create_user("handler", "handler@example.test", "Atlas-handler-5938!", is_staff=True)
        handler.user_permissions.add(Permission.objects.get(codename="change_feedback"))
        item = start(self.editor)
        with self.assertRaises(PermissionDenied):
            start(handler)
        with self.assertRaises(PermissionDenied):
            save_candidate(item.pk, actor=handler, expected_version=1, proposed=item.proposed, private_note="")
        with self.assertRaises(PermissionDenied):
            export_candidate(item.pk, actor=handler, expected_version=1)
        self.client.force_login(handler)
        for path in ("/admin/atlas/candidate/", "/admin/atlas/candidate/add/", f"/admin/atlas/candidate/{item.pk}/change/"):
            self.assertEqual(self.client.get(path).status_code, 403)

    def test_missing_initial_release_is_clear(self):
        ReleaseState.objects.filter(pk=1).update(current=None)
        with self.assertRaisesMessage(ValidationError, "尚无正式发布基线"):
            create_candidate(actor=self.editor, section="people", record_id="char_a",
                             expected_release="test-1", expected_digest="0" * 64)
        self.client.force_login(self.editor)
        self.assertContains(self.client.get("/admin/atlas/candidate/add/"), "尚无正式发布基线")

    def test_admin_can_create_and_fill_new_evidence_without_json_input(self):
        self.client.force_login(self.editor)
        release = ReleaseState.objects.get(pk=1).current
        response = self.client.post("/admin/atlas/candidate/add/", {
            "section": "evidence", "record_id": "", "relationship_id": "char_a|char_b",
            "base_release": release.pk, "base_digest": release.manifest["data_digest"],
        })
        self.assertEqual(response.status_code, 302)
        item = Candidate.objects.get()
        payload = RecordForm(candidate=item).initial
        payload.update({"record_quote": "新找到的独立原文。", "sources-TOTAL_FORMS": "2",
                        "sources-INITIAL_FORMS": "0", "sources-MIN_NUM_FORMS": "0", "sources-MAX_NUM_FORMS": "100",
                        "sources-0-kind": "story", "sources-0-source": "新增出处.txt", "sources-0-line": "10",
                        "sources-0-endLine": "12", "sources-0-version": "来源版本", "sources-1-kind": ""})
        path = f"/admin/atlas/candidate/{item.pk}/change/"
        self.assertEqual(self.client.post(path, payload).status_code, 302)
        item.refresh_from_db()
        self.assertEqual(item.proposed["sources"][0]["version"], "来源版本")
        self.assertEqual(item.proposed["sources"][0]["line"], 10)
        self.assertEqual(Evidence.objects.count(), 2)
        for invalid in ("not-a-number", "9" * 100):
            self.assertEqual(self.client.get(f"/admin/atlas/candidate/{invalid}/change/").status_code, 404)

    def test_admin_field_edit_preview_and_download_require_csrf(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.force_login(self.editor)
        item = start(self.editor)
        path = f"/admin/atlas/candidate/{item.pk}/change/"
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, 'name="proposed"')
        token = response.cookies["csrftoken"].value
        payload = RecordForm(candidate=item).initial
        payload["record_name"] = "表单修改"
        self.assertEqual(self.client.post(path, payload).status_code, 403)
        self.assertEqual(self.client.post(path, payload, HTTP_X_CSRFTOKEN=token).status_code, 302)
        self.assertContains(self.client.get(path), "表单修改")
        self.assertEqual(self.client.post(path, payload, HTTP_X_CSRFTOKEN=token).status_code, 200)
        self.assertEqual(self.client.post(f"/admin/atlas/candidate/{item.pk}/export/", {"version_token": 2},
                                         HTTP_X_CSRFTOKEN=token).status_code, 200)
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locks")
class CandidateConcurrencyTests(TransactionTestCase):
    def setUp(self):
        legacy_fixture()
        publish(package_for(export_database()))
        self.editor = editor_user()

    def test_parallel_edit_rejects_stale_version(self):
        item = start(self.editor)
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.editor.pk)
                barrier.wait(timeout=10)
                save_candidate(item.pk, actor=actor, expected_version=1,
                               proposed={**item.proposed, "name": f"候选 {index}"}, private_note="")
                return "saved"
            except ValidationError:
                return "stale"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, range(2)))
        self.assertEqual(sorted(results), ["saved", "stale"])
        self.assertEqual(CandidateEdit.objects.filter(candidate=item).count(), 2)
        self.assertEqual(Candidate.objects.get(pk=item.pk).version, 2)
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")

    def test_release_committing_while_edit_waits_rejects_old_baseline(self):
        item = start(self.editor)
        package = package_for(export_database(), "test-2", "test-1")
        started = Event()

        def edit():
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.editor.pk)
                started.set()
                save_candidate(item.pk, actor=actor, expected_version=1,
                               proposed={**item.proposed, "name": "旧基线候选"}, private_note="")
                return "saved"
            except ValidationError:
                return "stale"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                ReleaseState.objects.select_for_update().get(pk=1)
                future = pool.submit(edit)
                self.assertTrue(started.wait(timeout=10))
                publish(package)
            self.assertEqual(future.result(timeout=10), "stale")
        self.assertEqual(Candidate.objects.get(pk=item.pk).version, 1)
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")
