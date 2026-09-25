import copy
from unittest.mock import patch

from django.db import connection
from django.test import Client, TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from .preference_models import PreferenceCatalog, PreferenceControl
from .preference_services import digest
from .public_cache import responses
from .source_data import export_database
from .test_preferences import setup_data
from .test_releasing import legacy_fixture, package_for, publish


class PublicCacheTests(TestCase):
    def setUp(self):
        responses.clear()
        self.addCleanup(responses.clear)

    def test_graph_hot_read_and_304_skip_graph_queries_and_encoding(self):
        legacy_fixture()
        data = export_database()
        publish(package_for(data))
        first = self.client.get('/api/graph/?scope=all')
        self.assertEqual(first.status_code, 200)
        with patch('atlas.views.GraphView.payload', side_effect=AssertionError('Graph rebuilt')), \
                CaptureQueriesContext(connection) as queries:
            hot = self.client.get('/api/graph/?scope=all')
            self.assertEqual(hot.content, first.content)
            responses.clear()
            # 弱 ETag 与多值条件也应在冷缓存时直接返回 304。
            response = self.client.get('/api/graph/?scope=all', HTTP_IF_NONE_MATCH=f'"other", W/{first["ETag"]}')
            self.assertEqual(response.status_code, 304)
            self.assertEqual(response.content, b'')
        self.assertFalse(any('FROM "atlas_person"' in q['sql'] or 'FROM "atlas_relationship"' in q['sql'] for q in queries))
        operators = self.client.get('/api/graph/?scope=operators')
        self.assertNotEqual(operators['ETag'], first['ETag'])
        data['people'][0]['name'] = 'Published correction'
        publish(package_for(data, 'test-2', 'test-1'))
        updated = self.client.get('/api/graph/?scope=all', HTTP_IF_NONE_MATCH=first['ETag'])
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()['dataRelease']['id'], 'test-2')
        self.assertNotEqual(updated['ETag'], first['ETag'])

    def test_unversioned_graph_does_not_reuse_response(self):
        legacy_fixture()
        with patch('atlas.views.GraphView.payload', return_value={'nodes': []}) as build:
            self.client.get('/api/graph/')
            self.client.get('/api/graph/')
        self.assertEqual(build.call_count, 2)

    def test_directory_cache_is_public_but_maintenance_and_private_state_are_live(self):
        setup_data()
        client = Client(enforce_csrf_checks=True)
        runtime = client.get('/api/preferences/runtime/')
        self.assertIn('csrftoken', runtime.cookies)
        self.assertEqual(runtime['Cache-Control'], 'private, no-store')
        self.assertNotIn('catalog', runtime.json())
        first = client.get('/api/preferences/directory/?version=test-v1')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(set(first.json()), {'catalog'})
        self.assertNotIn('Cookie', first.get('Vary', ''))
        self.assertFalse(first.cookies)
        with patch('atlas.preference_views.catalog_payload', side_effect=AssertionError('Catalog rebuilt')), \
                CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get('/api/preferences/directory/?version=test-v1').content, first.content)
            responses.clear()
            self.assertEqual(client.get('/api/preferences/directory/?version=test-v1', HTTP_IF_NONE_MATCH=first['ETag']).status_code, 304)
        self.assertFalse(any('"atlas_preferencecatalog"."payload"' in q['sql'] for q in queries))
        PreferenceControl.objects.update(writes_enabled=False, tasks_enabled=False)
        runtime = client.get('/api/preferences/runtime/').json()
        self.assertFalse(runtime['config']['writes_enabled'])
        self.assertFalse(runtime['config']['tasks_enabled'])
        self.assertEqual(client.get('/api/preferences/directory/?version=test-v1', HTTP_IF_NONE_MATCH=first['ETag']).status_code, 304)
        PreferenceControl.objects.update(reads_enabled=False)
        blocked = client.get('/api/preferences/directory/?version=test-v1', HTTP_IF_NONE_MATCH=first['ETag'])
        self.assertEqual(blocked.status_code, 503)
        self.assertEqual(blocked['Cache-Control'], 'private, no-store')
        self.assertNotIn('ETag', blocked)
        with override_settings(PREFERENCES_ENABLED=False):
            self.assertEqual(client.get('/api/preferences/runtime/').status_code, 503)

    def test_directory_publication_refuses_old_version_and_changes_etag(self):
        actor, _ = setup_data()
        first = self.client.get('/api/preferences/directory/?version=test-v1')
        payload = copy.deepcopy(first.json()['catalog'])
        payload['version'] = 'test-v2'
        payload['persons'][0]['name'] = 'Published name'
        catalog = PreferenceCatalog.objects.create(version='test-v2', digest=digest(payload), payload=payload,
                                                   status='published', created_by=actor)
        PreferenceControl.objects.update(catalog=catalog)
        stale = self.client.get('/api/preferences/directory/?version=test-v1', HTTP_IF_NONE_MATCH=first['ETag'])
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale['Cache-Control'], 'private, no-store')
        fresh = self.client.get('/api/preferences/directory/?version=test-v2', HTTP_IF_NONE_MATCH=first['ETag'])
        self.assertEqual(fresh.status_code, 200)
        self.assertNotEqual(fresh['ETag'], first['ETag'])
        self.assertEqual(fresh.json()['catalog']['persons'][0]['name'], 'Published name')
        # 兼容原接口，旧页面仍可取得实时配置与原目录。
        self.assertEqual(self.client.get('/api/preferences/catalog/').json()['catalog']['version'], 'test-v2')
