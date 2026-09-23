from django.test import SimpleTestCase, override_settings


@override_settings(DEBUG=False, CLOUDFLARE_WEB_ANALYTICS_TOKEN="0123456789abcdef" * 2)
class SiteConfigTests(SimpleTestCase):
    def test_anonymous_config_only_exposes_public_token_without_database_or_cookies(self):
        self.client.cookies["sessionid"] = "invalid-session"
        with override_settings(SECRET_KEY="private-key-must-not-be-returned"):
            response = self.client.get("/api/site-config/", secure=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"cloudflareWebAnalyticsToken": "0123456789abcdef" * 2})
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertFalse(response.cookies)

    def test_missing_or_invalid_tokens_disable_analytics_without_breaking_the_endpoint(self):
        for token in ("", "not-a-token", "a" * 31, "a" * 33, '"</script><script>alert(1)</script>'):
            with self.subTest(token=token), override_settings(CLOUDFLARE_WEB_ANALYTICS_TOKEN=token):
                response = self.client.get("/api/site-config/", secure=True)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"cloudflareWebAnalyticsToken": ""})

    @override_settings(DEBUG=True)
    def test_debug_mode_does_not_publish_a_configured_token(self):
        self.assertEqual(self.client.get("/api/site-config/", secure=True).json(),
                         {"cloudflareWebAnalyticsToken": ""})

    def test_query_parameters_cannot_override_the_server_config(self):
        response = self.client.get("/api/site-config/?cloudflareWebAnalyticsToken=untrusted", secure=True)
        self.assertEqual(response.json(), {"cloudflareWebAnalyticsToken": "0123456789abcdef" * 2})

    def test_config_is_read_only(self):
        self.assertEqual(self.client.post("/api/site-config/", {}, secure=True).status_code, 405)
