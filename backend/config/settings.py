import os
from pathlib import Path
from urllib.parse import unquote, urlparse

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv("DJANGO_DEBUG", "1") == "1"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "local-development-only-do-not-deploy-this-key")
if not DEBUG and (not os.getenv("DJANGO_SECRET_KEY") or len(SECRET_KEY) < 50):
    raise ImproperlyConfigured("Production requires DJANGO_SECRET_KEY with at least 50 characters.")
ALLOWED_HOSTS = os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(",")
CSRF_TRUSTED_ORIGINS = [x for x in os.getenv("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if x]
INSTALLED_APPS = [
    "atlas.admin_config.AtlasAdminConfig",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "atlas",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
database_url = os.getenv("DATABASE_URL", "")
if database_url:
    parsed = urlparse(database_url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise ImproperlyConfigured("DATABASE_URL must use PostgreSQL.")
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": unquote(parsed.path[1:]),
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname or "localhost",
            "PORT": parsed.port or 5432,
            "CONN_MAX_AGE": 60,
        }
    }
elif DEBUG:
    # 便于无 PostgreSQL 的开发机启动；生产强制 PostgreSQL，验收也在 PostgreSQL 执行。
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
else:
    raise ImproperlyConfigured("Production requires DATABASE_URL.")
AUTH_USER_MODEL = "atlas.User"
ADMIN_LOGIN_IP_LIMIT = int(os.getenv("ADMIN_LOGIN_IP_LIMIT", "30"))
ADMIN_LOGIN_ACCOUNT_LIMIT = int(os.getenv("ADMIN_LOGIN_ACCOUNT_LIMIT", "8"))
ASSET_MANIFEST_PATH = os.getenv("ASSET_MANIFEST_PATH", str(BASE_DIR.parent / "assets/resource-manifest.json"))
FORMAL_DATA_MANAGED = os.getenv("FORMAL_DATA_MANAGED", "1") == "1"
if not DEBUG and not FORMAL_DATA_MANAGED:
    raise ImproperlyConfigured("Production requires FORMAL_DATA_MANAGED=1.")
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticatedOrReadOnly"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["atlas.throttles.WriteThrottle"],
    "DEFAULT_THROTTLE_RATES": {"write": "60/hour", "auth": "15/hour"},
    "EXCEPTION_HANDLER": "atlas.api_errors.exception_handler",
}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.db.DatabaseCache", "LOCATION": "atlas_cache"}}
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_SSL_REDIRECT = not DEBUG
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
DATA_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024 * 1024
PUBLIC_ORIGIN = os.getenv("PUBLIC_ORIGIN", "http://127.0.0.1:5173").rstrip("/")
CLOUDFLARE_WEB_ANALYTICS_TOKEN = os.getenv("CLOUDFLARE_WEB_ANALYTICS_TOKEN", "").strip()
EMAIL_BACKEND = os.getenv(
    "EMAIL_BACKEND",
    "django.core.mail.backends.console.EmailBackend"
    if DEBUG
    else "django.core.mail.backends.smtp.EmailBackend",
)
EMAIL_HOST = os.getenv("EMAIL_HOST", "")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.getenv("EMAIL_USE_TLS", "1") == "1"
EMAIL_TIMEOUT = 10
EMAIL_FILE_PATH = os.getenv("EMAIL_FILE_PATH", str(BASE_DIR.parent / ".runtime/emails"))
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "archive@localhost")
PASSWORD_RESET_TIMEOUT = 3600
COMMUNITY_ENABLED = os.getenv("COMMUNITY_ENABLED", "0") == "1"
REGISTRATION_ENABLED = os.getenv("REGISTRATION_ENABLED", "0") == "1"

FEEDBACK_RATE_PER_HOUR = 5
FEEDBACK_CONTACT_RETENTION_DAYS = 90
FEEDBACK_RETENTION_DAYS = 365

FEEDBACK_TRUSTED_PROXY_IPS = tuple(x.strip() for x in os.getenv("FEEDBACK_TRUSTED_PROXY_IPS", "").split(",") if x.strip())

PREFERENCES_ENABLED = os.getenv("PREFERENCES_ENABLED", "1") == "1"
PREFERENCE_COOKIE_NAME = "atlas_preferences"
PREFERENCE_COOKIE_SECURE = not DEBUG
PREFERENCE_WEEKLY_LIMIT = 300
PREFERENCE_ROLLING_LIMIT = 1200
PREFERENCE_PERSON_LIMIT = 6
PREFERENCE_TASK_HOURS = 24
PREFERENCE_COOLDOWN_HOURS = 24
PREFERENCE_AGGREGATION_INTERVAL_MINUTES = 60
PREFERENCE_BOOTSTRAP_SAMPLES = 1000
PREFERENCE_BT_MAX_ITERATIONS = 5000
PREFERENCE_BT_TOLERANCE = 1e-6
PREFERENCE_BT_GRADIENT_TOLERANCE = 1e-6
PREFERENCE_MIN_COMPARISONS = 30
PREFERENCE_MIN_PARTICIPANTS = 30
PREFERENCE_MIN_OPPONENTS = 15
PREFERENCE_DETAIL_RETENTION_DAYS = 180
PREFERENCE_RISK_RETENTION_DAYS = 30
PREFERENCE_ASSET_ROOT = os.getenv("PREFERENCE_ASSET_ROOT", str(BASE_DIR.parent / "assets/preferences"))

PREFERENCE_MANIFEST_PATH = os.getenv("PREFERENCE_MANIFEST_PATH", str(BASE_DIR.parent / "assets/preferences-manifest.json"))
PREFERENCE_ROLLING_DAYS = 28
PREFERENCE_SUPPORT_LIMIT = 15
PREFERENCE_FAVORITE_LIMIT = 3
PREFERENCE_COVERAGE_FRACTION = 0.2
PREFERENCE_REGISTRATION_MIN_PARTICIPANTS = 30
PREFERENCE_SENSITIVITY_CAP = 20
PREFERENCE_MAX_INTERVAL_WIDTH = 30
PREFERENCE_MAX_SENSITIVITY_SHIFT = 10
# 整个28/84天窗口各自封顶，周额度刷新不产生新的统计预算。
PREFERENCE_WEIGHT_TOTAL_CAP = 50.0
PREFERENCE_WEIGHT_PERSON_CAP = 1.0
PREFERENCE_BT_PRIOR = 0.5
PREFERENCE_MIN_WEIGHTED_EVIDENCE = 20.0
PREFERENCE_MIN_EFFECTIVE_PARTICIPANTS = 30.0
PREFERENCE_COMPOSITE_RANDOM_WEIGHT = 0.70
PREFERENCE_COMPOSITE_MIN_POOL = 3
PREFERENCE_COMPOSITE_MIN_SUPPORT_PARTICIPANTS = 30
PREFERENCE_PAIR_REPEAT_DAYS = 84
PREFERENCE_REST_INTERVAL = 50
