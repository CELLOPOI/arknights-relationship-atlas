import copy
import json
import tempfile
from io import StringIO
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings

from .importing import import_bundle
from .models import Evidence, Identity, Person, Relationship, User
from .source_data import (
    canonical_data,
    compare_data,
    compile_graph,
    compile_source,
    digest,
    export_database,
    json_bytes,
    load_source,
    read_json,
    snapshot_data,
    source_filename,
    validate_data,
    write_source,
)
from .tests import EVIDENCE, GRAPH

ROOT = Path(__file__).resolve().parents[2]


@override_settings(FORMAL_DATA_MANAGED=False)
class SourceDatabaseTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        import_bundle(GRAPH, EVIDENCE)

    def test_export_preserves_backend_edits_identity_visibility_and_independent_evidence(self):
        User.objects.create_user("private", "private@example.test", "private-password")
        Person.objects.filter(pk="char_a").update(name="后台修订", published=False)
        Relationship.objects.filter(pk="char_a|person_c").update(published=False)
        Identity.objects.create(external_id="alternate", person_id="char_a", label="独立形态")
        extra = Evidence.objects.create(relationship_id="char_a|char_b", quote="另一条原文", sources=[
            {"kind": "story", "source": "additional.txt", "line": 5, "endLine": 8, "version": "abc"}
        ])
        data = export_database()
        self.assertEqual(data["people"][0]["name"], "后台修订")
        self.assertIs(data["people"][0]["published"], False)
        self.assertIs(data["relationships"][1]["published"], False)
        self.assertIn({"external_id": "alternate", "person_id": "char_a", "label": "独立形态", "published": True}, data["identities"])
        self.assertEqual(len(data["evidence"]), 3)
        self.assertIn(f"database:{extra.pk}", [e["id"] for e in data["evidence"]])
        self.assertNotIn(b"private", json_bytes(data))
        self.assertNotIn(b"password", json_bytes(data))
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "source"
            write_source(data, output, metadata={})
            restored, _ = load_source(output)
        self.assertEqual(restored, data)

    def test_type_reference_direction_and_evidence_errors_are_rejected(self):
        original = export_database()
        mutations = [
            lambda d: d["people"][0].update(published="false"),
            lambda d: d["people"][0].update(faction_id="missing"),
            lambda d: d["people"][0].update(aliases=[1]),
            lambda d: d["people"][0].update(aliases={}),
            lambda d: d["people"][0].update(aliases=""),
            lambda d: d["people"][0].update(private_note="secret"),
            lambda d: d["identities"][0].update(person_id="missing"),
            lambda d: d["relationships"][0].update(awareness_from_id="char_a"),
            lambda d: d["relationships"][1].update(awareness_from_id=None),
            lambda d: d["relationships"][1].update(person_b_id="char_a"),
            lambda d: d["relationships"].append({**d["relationships"][0], "id": "duplicate-pair"}),
            lambda d: d["evidence"].pop(),
            lambda d: d["evidence"][0].update(relationship_id="missing"),
            lambda d: d["evidence"][0].update(quote=" "),
            lambda d: d["evidence"][0]["sources"][0].update(line=10, endLine=2),
            lambda d: d["people"].append(d["people"][0]),
            lambda d: d.update(schema_version=True),
            lambda d: d.update(provenance={"unknown": []}),
        ]
        for index, mutation in enumerate(mutations):
            data = copy.deepcopy(original)
            mutation(data)
            with self.subTest(index=index), self.assertRaises(ValidationError):
                validate_data(data)

    def test_published_graph_derives_scope_fields_without_conditional_edges(self):
        data = export_database()
        # 条件内容不进入编译器的关系输入；完整条件结构另用真实全量包校验。
        data["conditional"] = [{"key": "char_b|person_c"}]
        self.assertEqual(len(compile_graph(data)["edges"]), 2)
        self.assertEqual(len(compile_graph(data, scope="operators")["edges"]), 1)
        Person.objects.filter(pk="char_a").update(published=False)
        self.assertEqual(compile_graph(export_database())["edges"], [])

    def test_filenames_are_portable_and_corruption_is_rejected(self):
        data = export_database()
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "source"
            write_source(data, output, metadata={})
            for path in output.rglob("*.json"):
                self.assertRegex(path.name, r"^(record-[a-f0-9]{64}|manifest)\.json$")
            row = data["people"][0]
            path = output / source_filename("people", row["id"])
            path.write_bytes(json_bytes({**row, "id": "changed"}))
            with self.assertRaisesMessage(ValidationError, "filename mismatch"):
                load_source(output)
            path.write_bytes(json_bytes(row))
            (output / "unexpected.json").write_text("{}")
            with self.assertRaisesMessage(ValidationError, "Unknown source file"):
                load_source(output)
            with self.assertRaisesMessage(ValidationError, "refusing to overwrite"):
                write_source(data, output, metadata={})

@override_settings(FORMAL_DATA_MANAGED=False)
class SourceExportTests(TransactionTestCase):
    def setUp(self):
        import_bundle(GRAPH, EVIDENCE)

    def test_export_command_does_not_modify_records_or_overwrite_exports(self):
        before = export_database()
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "export"
            call_command("export_formal_data", output=output, stdout=StringIO())
            self.assertEqual(read_json(output / "formal-data.json"), before)
            with self.assertRaises(CommandError):
                call_command("export_formal_data", output=output, stdout=StringIO())
        self.assertEqual(export_database(), before)

    def test_export_rejects_an_existing_transaction(self):
        with tempfile.TemporaryDirectory() as tmp, transaction.atomic(), self.assertRaisesMessage(
            CommandError, "requires its own read-only transaction"
        ):
            call_command("export_formal_data", output=Path(tmp) / "export", stdout=StringIO())


class FullSourceTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.legacy = snapshot_data(ROOT / "data/npc")

    def test_full_baseline_matches_legacy_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            write_source(self.legacy, source, metadata={})
            current, _ = load_source(source)
        self.assertEqual(compare_data(self.legacy, current), [])
        self.assertEqual(current["conditional"], self.legacy["conditional"])
        self.assertEqual(current["provenance"], self.legacy["provenance"])
        self.assertEqual((len(current["people"]), len(current["relationships"]), len(current["conditional"])),
                         (565, 5711, 12))
        self.assertEqual(len(compile_graph(current, scope="operators")["edges"]), 3703)

    def test_full_compilation_is_repeatable_and_database_independent(self):
        first = compile_source(ROOT / "data/source")
        second = compile_source(ROOT / "data/source")
        self.assertEqual(json_bytes(first), json_bytes(second))
        reordered = copy.deepcopy(self.legacy)
        for rows in reordered.values():
            if isinstance(rows, list):
                rows.reverse()
        self.assertEqual(digest(canonical_data(reordered)), digest(self.legacy))
        self.assertEqual(first["manifest"]["graph_digest"], digest(compile_graph(first["data"])))

    def test_preserved_narrative_metadata_cannot_silently_disappear(self):
        mutations = [
            lambda d: d["conditional"][0].pop("contributions"),
            lambda d: d["conditional"][0].update(contributions=[]),
            lambda d: d["conditional"][0].update(personIds=[[], {}]),
            lambda d: d["conditional"][0]["contributions"][0].update(realityScope="actual"),
            lambda d: d["provenance"].update({next(iter(d["provenance"])): [None]}),
            lambda d: next(iter(d["provenance"].values()))[0].pop("citations"),
        ]
        for index, mutation in enumerate(mutations):
            data = copy.deepcopy(self.legacy)
            mutation(data)
            with self.subTest(index=index), self.assertRaises(ValidationError):
                validate_data(data)

    def test_json_rejects_duplicate_keys_and_nonfinite_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "invalid.json"
            for content in ('{"id":"a","id":"b"}', '{"value":NaN}', '{"value":Infinity}'):
                path.write_text(content)
                with self.subTest(content=content), self.assertRaises(ValidationError):
                    read_json(path)
            path.write_text(json.dumps({"valid": True}))
            self.assertEqual(read_json(path), {"valid": True})
