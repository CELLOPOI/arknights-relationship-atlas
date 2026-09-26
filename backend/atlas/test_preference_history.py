"""历史节点筛选只物化选中榜单，半小时汇总沿用版本过期条件。"""
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from .preference_models import PreferenceControl, PreferenceSnapshot
from .preference_services import iso
from .preference_statistics import algorithm_version, series_key, snapshot_data
from .test_preferences import setup_data


@override_settings(PREFERENCE_AGGREGATION_INTERVAL_MINUTES=30)
class PreferenceHistoryTests(TestCase):
    def setUp(self):
        setup_data()
        self.now = datetime(2026, 9, 26, 20, tzinfo=UTC)
        self.algorithm = algorithm_version()

    def snapshot(self, cutoff, *, kind="random", count=1, reference="pool-a", **overrides):
        payload = {"rows": [{"id": "a", "count": count, "score": count}], "reference_version": reference}
        return PreferenceSnapshot(
            scope="person", kind=kind, window=84 if kind in ("random", "composite") else 0,
            cutoff=cutoff, catalog_version=overrides.pop("catalog_version", "test-v1"),
            algorithm_version=overrides.pop("algorithm_version", self.algorithm),
            asset_version=overrides.pop("asset_version", "test-assets"),
            revision=overrides.pop("revision", 0), payload=payload, **overrides)

    def trends(self, kind="random"):
        with patch("atlas.preference_views.timezone.now", return_value=self.now):
            response = self.client.get(f"/api/preferences/trends/?kind={kind}")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_dense_history_preserves_daily_series_nodes_and_only_loads_selected_payloads(self):
        snapshots = [self.snapshot(self.now - timedelta(days=day, hours=hour), count=day)
                     for day in range(182) for hour in (0, 1, 2)]
        # 16:00 UTC 跨越上海日期，但仍属于同一个 UTC 日节点。
        snapshots += [self.snapshot(self.now - timedelta(hours=5)),
                      self.snapshot(self.now - timedelta(hours=4), reference="pool-b"),
                      self.snapshot(self.now - timedelta(hours=3), revision=1),
                      self.snapshot(self.now - timedelta(minutes=30), algorithm_version="previous-algorithm"),
                      self.snapshot(self.now - timedelta(minutes=20), catalog_version="previous-catalog"),
                      self.snapshot(self.now - timedelta(minutes=10), asset_version="previous-assets"),
                      self.snapshot(self.now - timedelta(minutes=5), reference=None),
                      self.snapshot(self.now - timedelta(minutes=4), reference=None)]
        del snapshots[-1].payload["reference_version"]
        PreferenceSnapshot.objects.bulk_create(snapshots)
        # 用原有筛选规则生成期望值，包含同日口径变化、UTC 日期与 180 个节点上限。
        expected, seen = [], set()
        for item in PreferenceSnapshot.objects.filter(cutoff__gte=self.now - timedelta(days=180)).order_by("-cutoff", "-revision"):
            key = (item.cutoff.date(), *series_key(item))
            if key not in seen:
                expected.append(item)
                seen.add(key)
            if len(expected) == 180:
                break
        loaded = []
        original = PreferenceSnapshot.from_db

        def from_db(*args):
            item = original(*args)
            loaded.append(item.pk)
            return item

        with timezone.override("Asia/Shanghai"), patch.object(PreferenceSnapshot, "from_db", side_effect=from_db):
            response = self.trends()
        self.assertEqual(response, {"snapshots": [snapshot_data(item) for item in reversed(expected)],
                                    "changes": {"7": None, "28": None}})
        self.assertCountEqual(loaded, [item.pk for item in expected])
        self.assertEqual(len(loaded), 180)

    def test_support_and_composite_keep_exact_baseline_windows(self):
        for kind in ("support", "composite"):
            latest = self.snapshot(self.now, kind=kind, count=40)
            week = self.snapshot(self.now - timedelta(days=7), kind=kind, count=12)
            month = self.snapshot(self.now - timedelta(days=28), kind=kind, count=5)
            PreferenceSnapshot.objects.bulk_create([
                latest, week, month,
                self.snapshot(self.now - timedelta(days=7, hours=1), kind=kind, count=10),
                self.snapshot(self.now - timedelta(days=28, hours=1), kind=kind, count=3),
            ])
            result = self.trends(kind)
            self.assertEqual(result["changes"], {
                "7": {"baseline_at": iso(week.cutoff), "rows": [{"id": "a", "delta": 28}]},
                "28": {"baseline_at": iso(month.cutoff), "rows": [{"id": "a", "delta": 35}]},
            })
            self.assertEqual([row["id"] for row in result["snapshots"]], [month.pk, week.pk, latest.pk])

    def test_baseline_does_not_skip_a_newer_incompatible_reference(self):
        PreferenceSnapshot.objects.bulk_create([
            self.snapshot(self.now, kind="support", count=40),
            self.snapshot(self.now - timedelta(days=7), kind="support", reference="different-pool"),
            self.snapshot(self.now - timedelta(days=7, minutes=1), kind="support", count=10),
            self.snapshot(self.now - timedelta(days=29), kind="support", count=3),
        ])
        self.assertEqual(self.trends("support")["changes"], {"7": None, "28": None})

    def test_half_hour_rankings_are_current_until_one_hour_for_every_kind(self):
        for kind in ("random", "support", "composite", "form", "skin"):
            with self.subTest(kind=kind):
                item = self.snapshot(self.now, kind=kind, object_id="a" if kind in ("form", "skin") else "")
                item.save()
                url = f"/api/preferences/rankings/?kind={kind}" + ("&object_id=a" if item.object_id else "")
                for age, expected in ((timedelta(minutes=30), "current"),
                                      (timedelta(hours=1), "current"),
                                      (timedelta(hours=1, seconds=1), "delayed")):
                    PreferenceSnapshot.objects.filter(pk=item.pk).update(generated_at=self.now - age)
                    with patch("atlas.preference_views.timezone.now", return_value=self.now):
                        self.assertEqual(self.client.get(url).json()["status"], expected)

    def test_recent_snapshot_still_reports_catalog_algorithm_and_revision_changes(self):
        item = self.snapshot(self.now, kind="support")
        item.save()
        for fields in ({"catalog_version": "old-catalog"}, {"algorithm_version": "old-algorithm"}, {}):
            with self.subTest(fields=fields):
                PreferenceSnapshot.objects.filter(pk=item.pk).update(
                    catalog_version="test-v1", algorithm_version=self.algorithm, generated_at=self.now)
                if fields:
                    PreferenceSnapshot.objects.filter(pk=item.pk).update(**fields)
                else:
                    PreferenceControl.objects.filter(pk=1).update(revision=1)
                with patch("atlas.preference_views.timezone.now", return_value=self.now):
                    self.assertEqual(self.client.get("/api/preferences/rankings/?kind=support").json()["status"], "delayed")
