"""Run backend checks with an isolated database and in-memory email delivery."""

import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", choices=("sqlite", "postgres"))
    args = parser.parse_args()

    database_url = ""
    if args.database == "postgres":
        database_url = os.environ.get("ATLAS_TEST_DATABASE_URL", "")
        parsed = urlparse(database_url)
        # 专用基础库与随机测试库分开，避免使用网站的 DATABASE_URL。
        if parsed.scheme not in ("postgres", "postgresql") or not re.fullmatch(
            r"atlas_check_[a-zA-Z0-9_]+", unquote(parsed.path[1:])
        ):
            parser.error("Set ATLAS_TEST_DATABASE_URL to a dedicated PostgreSQL database named atlas_check_<name>.")

    os.environ["DATABASE_URL"] = database_url
    os.environ["DJANGO_DEBUG"] = "1"
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

    from config import settings

    if args.database == "sqlite":
        settings.DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
    else:
        settings.DATABASES["default"]["TEST"] = {"NAME": f"test_atlas_{uuid4().hex}"}
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

    import django
    from django.core.management import call_command

    django.setup()
    call_command("check")
    call_command("makemigrations", check=True, dry_run=True)
    call_command("test", "atlas", interactive=False)


if __name__ == "__main__":
    main()
