from collections import Counter
from datetime import timedelta

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from .preference_algorithm import cluster_sample, composite_index, weight_comparisons
from .preference_models import PreferenceSnapshot, PreferenceTask
from .preference_services import issue_task
from .preference_statistics import aggregate, algorithm_version, analyze_random, fit_bt, series_key
from .test_preferences import payload, perform, setup_data


def row(uid, left, right, winner=None, day=0, outcome="choose"):
    return {"participant_id": uid, "left_id": left, "right_id": right, "winner_id": winner or left,
            "accepted_at": timezone.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=day),
            "outcome": outcome, "strategy": "uniform-v1"}


class ContributionTests(SimpleTestCase):
    def test_dual_bounds_cross_weeks_and_latest_not_latest_skip(self):
        raw = [row("active", str(i), str(j), day=(i + j) % 83) for i in range(80) for j in range(i + 1, 80)]
        raw += [row("active", "0", "1", "1", day=0), row("active", "0", "1", day=-1, outcome="skip")]
        saved = list(raw)
        result = weight_comparisons(raw)
        by_person = Counter()
        for item in result:
            by_person[item["left_id"]] += item["weight"]
            by_person[item["right_id"]] += item["weight"]
        self.assertLessEqual(sum(item["weight"] for item in result), 50 + 1e-9)
        self.assertLessEqual(max(by_person.values()), 1 + 1e-9)
        self.assertEqual(next(r for r in result if {r["left_id"], r["right_id"]} == {"0", "1"})["winner_id"], "1")
        self.assertEqual(raw, saved)
        self.assertNotIn("weight", raw[0])

    def test_global_budget_binds_for_broad_distinct_pairs(self):
        weighted = weight_comparisons([row("broad", str(i * 2), str(i * 2 + 1)) for i in range(120)])
        self.assertAlmostEqual(sum(r["weight"] for r in weighted), 50)
        self.assertTrue(all(r["weight"] < 1 for r in weighted))

    def test_single_answer_and_person_cap(self):
        self.assertEqual(weight_comparisons([row("new", "a", "b")])[0]["weight"], 1)
        result = weight_comparisons([row("active", "a", str(i), day=i % 84) for i in range(100)])
        self.assertAlmostEqual(sum(r["weight"] for r in result), 1)

    def test_exchange_sides_and_bootstrap_copies(self):
        raw = [row("u", "a", "b"), row("u", "a", "c"), row("v", "b", "c")]
        weighted = weight_comparisons(raw)
        swapped = weight_comparisons([dict(r, left_id=r["right_id"], right_id=r["left_id"]) for r in raw])
        self.assertEqual([r["weight"] for r in weighted], [r["weight"] for r in swapped])
        a, _ = fit_bt(["a", "b", "c"], weighted)
        b, _ = fit_bt(["a", "b", "c"], swapped)
        self.assertEqual(a, b)
        class SameGroup:
            def choice(self, keys):
                return "u"
        sample = cluster_sample(weighted, SameGroup())
        self.assertEqual(len(sample), 4)
        self.assertEqual(sum(r["weight"] for r in sample), 2)

    def test_composite_ties_zero_support_and_no_fabricated_missing(self):
        rows = [{"id": p, "score": value, "status": status} for p, value, status in
                [("a", 80, "ready"), ("b", 80, "ready"), ("c", 20, "ready"), ("new", None, "insufficient")]]
        support = [{"id": p, "count": 0} for p in ("a", "b", "c", "new")]
        result = composite_index(rows, support, support_participants=30)
        indexed = {r["id"]: r for r in result["rows"]}
        self.assertEqual(indexed["a"]["score"], indexed["b"]["score"])
        self.assertEqual(indexed["a"]["rank"], indexed["b"]["rank"])
        self.assertEqual(indexed["c"]["support_percentile"], 50)
        self.assertIsNone(indexed["new"]["score"])
        self.assertEqual(result["reference_pool"], ["a", "b", "c"])
        self.assertTrue(all(r["score"] is None for r in composite_index(rows, support)["rows"]))

    @override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=8, PREFERENCE_MIN_OPPONENTS=2,
                       PREFERENCE_MAX_INTERVAL_WIDTH=100)
    def test_windows_network_and_cold_start(self):
        now = timezone.now()
        data = [row(str(u), a, b, winner=a if u % 2 else b, day=40 if u < 35 else 2)
                for u in range(80) for a, b in (("a", "b"), ("b", "c"), ("a", "c"))]
        long = analyze_random(payload(), now, 84, data)
        short = analyze_random(payload(), now, 28, data)
        self.assertEqual(long["sample_size"], 240)
        self.assertEqual(short["sample_size"], 135)
        self.assertEqual(long["reference_pool"], ["a", "b", "c"])
        self.assertIsNone(next(r for r in long["rows"] if r["id"] == "d")["score"])
        self.assertEqual({r["status"] for r in long["rows"] if r["id"] != "d"}, {"ready"})
        mixed = analyze_random(payload(), now, 84, data + [row("other", "c", "d", outcome="skip")])
        self.assertEqual(long["weighted_evidence"], mixed["weighted_evidence"])


@override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=4)
class PreferenceV2PersistenceTests(TestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()

    def test_84_day_pair_restriction_keeps_28_day_person_quota(self):
        now = timezone.now()
        for a, b in (("a", "b"), ("a", "c"), ("a", "d"), ("b", "c"), ("b", "d")):
            PreferenceTask.objects.create(participant=self.participant, catalog_id="test-v1", left_id=a, right_id=b,
                pair_key=f"{a}|{b}", strategy="uniform-v1", status="answered", issued_at=now - timedelta(days=40),
                expires_at=now - timedelta(days=39), accepted_at=now - timedelta(days=40), outcome="skip")
        task = perform(self.participant, "task", issue_task)
        self.assertEqual({task["task"]["left_id"], task["task"]["right_id"]}, {"c", "d"})
        self.assertEqual(task["quota"]["rolling_used"], 1)

    def test_old_records_and_snapshots_preserved_and_parameter_series_split(self):
        now = timezone.now()
        old = PreferenceSnapshot.objects.create(kind="random", window=84, cutoff=now, payload={"rows": []},
                algorithm_version="bt-mm-cluster-v1", asset_version="test-assets", catalog_version="test-v1")
        aggregate(now)
        first = PreferenceSnapshot.objects.filter(scope="person", kind="composite").first()
        self.assertIsNotNone(first)
        self.assertEqual(first.algorithm_version, algorithm_version())
        self.assertEqual(PreferenceSnapshot.objects.get(pk=old.pk).payload, {"rows": []})
        with override_settings(PREFERENCE_WEIGHT_TOTAL_CAP=25):
            aggregate(now)
            second = PreferenceSnapshot.objects.filter(scope="person", kind="composite").first()
            self.assertNotEqual(series_key(first), series_key(second))
        self.assertEqual(PreferenceSnapshot.objects.filter(scope="person", kind="composite").count(), 2)

    def test_composite_endpoint_and_reference_change_suppresses_trend(self):
        now = timezone.now()
        for days, pool in ((7, ["a", "b", "c"]), (0, ["a", "b", "d"])):
            PreferenceSnapshot.objects.create(kind="composite", window=84, cutoff=now - timedelta(days=days),
                payload={"rows": [{"id": "a", "score": 60}], "reference_version": str(pool)},
                algorithm_version=algorithm_version(), asset_version="test-assets", catalog_version="test-v1")
        self.assertEqual(self.client.get("/api/preferences/rankings/?kind=composite").status_code, 200)
        self.assertIsNone(self.client.get("/api/preferences/trends/?kind=composite").json()["changes"]["7"])


class SupplementaryAvatarReviewTests(TestCase):
    def test_fixed_avatar_hash_and_review_version_are_bound_to_publication(self):
        import hashlib
        import json
        import tempfile
        from pathlib import Path

        from django.core.exceptions import ValidationError

        from .models import User
        from .source_data import export_database
        from .test_editorial import add, approve, make_batch, release, save
        from .test_releasing import TEST_ASSET_MANIFEST, legacy_fixture, package_for, publish

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "test.webp"
            image.write_bytes(b"test-reviewed-resource")
            manifest = root / "manifest.json"
            payload = {"version": "pref-assets-review-1", "files": [{"path": "test.webp",
                "bytes": image.stat().st_size, "sha256": hashlib.sha256(image.read_bytes()).hexdigest()}]}
            manifest.write_text(json.dumps(payload))
            with override_settings(ASSET_MANIFEST_PATH=TEST_ASSET_MANIFEST,
                                   PREFERENCE_MANIFEST_PATH=manifest, PREFERENCE_ASSET_ROOT=root):
                legacy_fixture()
                publish(package_for(export_database()))
                actor = User.objects.create_superuser("reviewer", "reviewer@example.test", "Test-only-123!")
                batch = make_batch(actor)
                save(add(batch, actor), actor, avatar="/assets/preferences/test.webp")
                approve(batch, actor)
                image.write_bytes(b"changed-file")
                with self.assertRaisesMessage(ValidationError, "fixed hash"):
                    release(batch, actor)
                image.write_bytes(b"test-reviewed-resource")
                payload["version"] = "pref-assets-review-2"
                manifest.write_text(json.dumps(payload))
                with self.assertRaises(ValidationError):
                    release(batch, actor)
                payload["version"] = "pref-assets-review-1"
                manifest.write_text(json.dumps(payload))
                published = release(batch, actor)
                self.assertEqual(published.manifest["preference_avatar_assets"]["version"], payload["version"])
