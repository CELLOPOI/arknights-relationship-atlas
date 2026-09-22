import copy
import json
from pathlib import Path

from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from .importing import import_bundle
from .models import Evidence
from .source_titles import describe_source, source_catalog
from .tests import EVIDENCE, GRAPH


class SourceTitleTests(SimpleTestCase):
    def test_story_number_is_resolved_from_configuration(self):
        relative = "obt/main/level_main_08-14_end.txt"
        for path in (relative, "ArknightsGameData/zh_CN/gamedata/story/" + relative):
            source = {"kind": "story", "source": path, "line": 501, "endLine": 509}
            rendered = describe_source(source)
            self.assertEqual(rendered["title"], "《怒号光明》 · M8-8 · 苏醒，浮出梦乡 · 行动后")
            self.assertEqual({key: rendered[key] for key in source}, source)
            self.assertNotIn("title", source)

    def test_summary_record_gameplay_and_extra_voice_stay_distinct(self):
        cases = [
            ("story", "[uc]info/activities/act38side/level_act38side_06_beg.txt", "剧情梗概"),
            ("story", "obt/memory/story_ifrit_1_1.txt", "伊芙利特 · 干员密录《小队长》"),
            ("story", "obt/roguelike/ro4/level_rogue4_ending_3.txt", "天使之城"),
            ("story", "obt/sandboxperm/sandbox_2/battleavg/dialog_sandbox_2_main1_3a_op.txt", "联络员来访"),
            ("story", "obt/tutorial/training/training_15.txt", "TR-15 · 战略转移 · 关卡内教学"),
            ("profile", "char_4219_yukari/module/uniequip_002_yukari", "岳羽由加莉 · 模组《命运的奖赏》"),
            ("profile", "char_4134_cetsyr/voice/char_4134_cetsyr_EX_CN_101", "特蕾西娅的留言「启航纪念」"),
        ]
        for kind, path, title in cases:
            with self.subTest(path=path):
                self.assertIn(title, describe_source({"kind": kind, "source": path})["title"])

    def test_unknown_paths_and_other_versions_keep_the_original_source(self):
        for source in [
            {"kind": "story", "source": "new-story.txt"},
            {"kind": "story", "source": "obt/main/level_main_08-14_end.txt", "version": "another-version"},
            {"kind": "story", "source": "https://example.test/obt/main/level_main_08-14_end.txt"},
        ]:
            self.assertEqual(describe_source(source), source)

    def test_every_baseline_citation_has_a_name_and_preserves_its_locator(self):
        source_root = Path(__file__).resolve().parents[2] / "data" / "source" / "evidence"
        counts = {}
        for file in source_root.glob("*.json"):
            item = json.loads(file.read_text(encoding="utf-8"))
            for source in item["sources"]:
                counts[source["kind"]] = counts.get(source["kind"], 0) + 1
                rendered = describe_source(source)
                self.assertTrue(rendered.get("title"), source)
                self.assertEqual({key: rendered[key] for key in source}, source)
        self.assertEqual(counts, {kind: value["total"] for kind, value in source_catalog()["stats"].items()})


@override_settings(FORMAL_DATA_MANAGED=False)
class SourceTitleAPITests(TestCase):
    def test_api_enriches_both_source_lists_without_writing_or_leaking_hidden_evidence(self):
        original = copy.deepcopy(EVIDENCE)
        source = {"kind": "story", "source": "activities/act23side/level_act23side_07_end.txt",
                  "line": 251, "endLine": 259, "version": source_catalog()["sourceCommit"]}
        original["char_a|char_b"]["sources"] = [source]
        import_bundle(GRAPH, original)
        item = Evidence.objects.get(relationship_id="char_a|char_b")
        hidden = Evidence.objects.create(relationship_id="char_a|char_b", quote="Hidden evidence",
                                         sources=[source], published=False)
        response = APIClient().get("/api/relationships/char_a%7Cchar_b/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["sources"], body["evidence"][0]["sources"])
        self.assertEqual(body["sources"][0]["title"], "《登临意》 · WB-7 · “屏风卫” · 行动后")
        self.assertEqual(body["evidence"][0]["quote"], item.quote)
        self.assertEqual([entry["id"] for entry in body["evidence"]], [item.pk])
        self.assertNotIn(hidden.quote, body["quote"])
        item.refresh_from_db()
        self.assertEqual(item.sources, [source])
