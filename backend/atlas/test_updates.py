from django.contrib.auth.models import Permission
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase

from .models import User
from .source_data import export_database
from .test_releasing import legacy_fixture, package_for, publish
from .update_models import SiteUpdate
from .update_services import set_update_publication


class SiteUpdateTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_superuser("publisher", "publisher@example.test", "Test-only-2794!")
        self.editor = User.objects.create_user("editor", "editor@example.test", "Test-only-2794!", is_staff=True)
        self.editor.user_permissions.add(*Permission.objects.filter(
            content_type__app_label="atlas", codename__in=("view_siteupdate", "change_siteupdate", "add_siteupdate")))

    def draft(self, key="feature-one", **fields):
        return SiteUpdate.objects.create(key=key, category="feature", title="新增更新记录", summary="查看网站功能变化。",
                                         changes="按时间查看更新。\n\n筛选剧情修订与功能更新。", **fields)

    def test_drafts_are_private_preview_is_authorized_and_never_cached(self):
        draft = self.draft()
        self.assertEqual(self.client.get("/api/updates/").json()["results"], [])
        url = f"/api/updates/{draft.pk}/preview/"
        self.assertEqual(self.client.get(url).status_code, 403)
        self.client.force_login(self.editor)
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertIn("private", response["Cache-Control"])
        self.assertEqual(response.json()["status"], "draft")
        self.editor.user_permissions.clear()
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_publish_withdraw_and_republish_preserve_first_publication_date(self):
        draft = self.draft(acknowledgements="感谢提供复现步骤的玩家。")
        update = set_update_publication(draft.pk, actor=self.actor, published=True)
        response = self.client.get("/api/updates/").json()
        self.assertEqual(response["count"], 1)
        public = response["results"][0]
        self.assertEqual(public["changes"], ["按时间查看更新。", "筛选剧情修订与功能更新。"])
        self.assertEqual(set(public), {"id", "category", "title", "summary", "changes", "status", "publishedAt"})
        self.assertNotIn("感谢提供复现步骤的玩家。", str(public))
        set_update_publication(draft.pk, actor=self.actor, published=False)
        self.assertEqual(self.client.get("/api/updates/").json()["count"], 0)
        again = set_update_publication(draft.pk, actor=self.actor, published=True)
        self.assertEqual(again.published_at, update.published_at)

    def test_story_update_cannot_claim_publication_before_a_real_data_release(self):
        draft = self.draft()
        draft.category = "story"
        draft.save()
        with self.assertRaises(ValidationError):
            set_update_publication(draft.pk, actor=self.actor, published=True)
        draft.refresh_from_db()
        self.assertEqual(draft.status, "draft")
        self.assertIsNone(draft.published_at)
        legacy_fixture()
        publish(package_for(export_database()))
        draft.data_release_id = "test-1"
        draft.save()
        set_update_publication(draft.pk, actor=self.actor, published=True)
        self.assertEqual(self.client.get("/api/updates/?category=story").json()["count"], 1)

    def test_editor_can_save_and_preview_but_cannot_publish(self):
        self.client.force_login(self.editor)
        url = "/admin/atlas/siteupdate/add/"
        self.assertNotContains(self.client.get(url), 'name="acknowledgements"')
        response = self.client.post(url, {"key": "from-admin", "category": "feature", "title": "功能变化",
                                         "summary": "后台填写。", "changes": "新增更新说明。", "_save": "保存"})
        self.assertEqual(response.status_code, 302)
        draft = SiteUpdate.objects.get(key="from-admin")
        with self.assertRaises(PermissionDenied):
            set_update_publication(draft.pk, actor=self.editor, published=True)
        response = self.client.get("/admin/atlas/siteupdate/")
        self.assertNotContains(response, 'value="publish_selected"')
        self.assertContains(response, f"/updates/?preview={draft.pk}")

    def test_admin_publish_action_and_stale_edit_protection(self):
        draft = self.draft()
        self.client.force_login(self.actor)
        url = f"/admin/atlas/siteupdate/{draft.pk}/change/"
        response = self.client.post(url, {"version_token": 0, "category": "feature", "title": "Stale title",
                                         "summary": "Summary", "changes": "Changes", "_save": "保存"})
        self.assertContains(response, "这份资料已被其他操作更新")
        draft.refresh_from_db()
        self.assertEqual(draft.title, "新增更新记录")
        response = self.client.post("/admin/atlas/siteupdate/", {"action": "publish_selected",
                                    "_selected_action": [str(draft.pk)], "index": "0"})
        self.assertEqual(response.status_code, 302)
        draft.refresh_from_db()
        self.assertEqual(draft.status, "published")
        self.assertNotContains(self.client.get(url), 'name="title"')
        self.assertNotContains(self.client.get(url), "field-acknowledgements")

    def test_pagination_filtering_and_invalid_queries(self):
        for index in range(22):
            set_update_publication(self.draft(key=f"feature-{index}").pk, actor=self.actor, published=True)
        first = self.client.get("/api/updates/?category=feature").json()
        self.assertEqual(len(first["results"]), 20)
        self.assertEqual(first["next"], 2)
        self.assertEqual(len(self.client.get("/api/updates/?page=2").json()["results"]), 2)
        self.assertEqual(self.client.get("/api/updates/?category=story").json()["results"], [])
        for query in ("page=bad", "page=999999999999999", "category=private"):
            self.assertEqual(self.client.get(f"/api/updates/?{query}").status_code, 400)
        self.assertEqual(self.client.get("/api/updates/?page=0").status_code, 404)
