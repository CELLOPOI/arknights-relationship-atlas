from datetime import timedelta

from django.conf import settings
from django.contrib.admin import AdminSite
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect

from .feedback_views import identity_key
from .ops_models import AdminLoginGuard


@transaction.atomic
def login_wait(request):
    now = timezone.now()
    duration = timedelta(minutes=15)
    ip = identity_key(request)
    username = request.POST.get("username", "")[:150]
    windows = {
        salted_hmac("atlas-admin-ip", ip, algorithm="sha256").hexdigest(): settings.ADMIN_LOGIN_IP_LIMIT,
        salted_hmac("atlas-admin-account", f"{ip}:{username}", algorithm="sha256").hexdigest():
            settings.ADMIN_LOGIN_ACCOUNT_LIMIT,
    }
    guards = []
    wait = 0
    for key, limit in sorted(windows.items()):
        guard, _ = AdminLoginGuard.objects.select_for_update().get_or_create(
            pk=key, defaults={"window_started": now, "expires_at": now + duration}
        )
        if now >= guard.window_started + duration:
            guard.window_started, guard.count = now, 0
        if guard.count >= limit:
            wait = max(wait, int((guard.window_started + duration - now).total_seconds()) + 1)
        guards.append(guard)
    if wait:
        return wait
    for guard in guards:
        guard.count += 1
        guard.expires_at = guard.window_started + duration
        guard.save(update_fields=["count", "window_started", "expires_at"])
    return 0


class AtlasAdminSite(AdminSite):
    @method_decorator([never_cache, csrf_protect])
    def login(self, request, extra_context=None):
        if request.method == "POST":
            wait = login_wait(request)
            if wait:
                response = HttpResponse("登录尝试过多，请稍后重试。", status=429, content_type="text/plain; charset=utf-8")
                response["Retry-After"] = str(wait)
                return response
        return super().login(request, extra_context=extra_context)
