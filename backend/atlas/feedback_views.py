"""独立匿名反馈入口；不复用旧账号社区权限或公开读取路由。"""

import ipaddress
import json
from datetime import timedelta
from functools import wraps
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import serializers
from rest_framework.exceptions import Throttled, ValidationError
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .feedback_models import FEEDBACK_TYPES, Feedback, FeedbackGuard, FeedbackReceipt
from .views import get_target

MAX_BODY_BYTES = 32 * 1024
CONFIRMATION = {"detail": "反馈已收到，维护者会核查。"}


def feedback_request_guard(view):
    @wraps(view)
    def guarded(request, *args, **kwargs):
        if request.method == "POST":
            if request.content_type != "application/json":
                return JsonResponse({"detail": "仅接受 JSON 格式，不接收附件。"}, status=415)
            # 使用有限读取，避免缺失或伪造 Content-Length 绕过实际正文大小限制。
            body = request.read(MAX_BODY_BYTES + 1)
            if len(body) > MAX_BODY_BYTES:
                return JsonResponse({"detail": "反馈内容过大，请缩短后重试。"}, status=413)
            request._body = body
            from io import BytesIO
            request._stream = BytesIO(body)
            origin = request.headers.get("Origin")
            expected = f"{request.scheme}://{request.get_host()}"
            if origin and origin != expected:
                return JsonResponse({"detail": "请从本站提交反馈。"}, status=403)
        return view(request, *args, **kwargs)
    return guarded


class StrictText(serializers.CharField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class FeedbackInput(serializers.Serializer):
    type = serializers.ChoiceField(choices=FEEDBACK_TYPES)
    description = StrictText(max_length=6000)
    targetType = serializers.ChoiceField(choices=["person", "relationship"], required=False)
    targetId = StrictText(max_length=220, required=False)
    sourceUrl = StrictText(max_length=1500, required=False, allow_blank=True)
    contact = StrictText(max_length=254, required=False, allow_blank=True)
    website = StrictText(max_length=200, required=False, allow_blank=True)

    def to_internal_value(self, data):
        if not isinstance(data, dict):
            raise ValidationError({"non_field_errors": ["请求内容必须是字段对象。"]})
        if set(data) - set(self.fields):
            raise ValidationError({"non_field_errors": ["请求包含未声明的字段。"]})
        return super().to_internal_value(data)

    def validate(self, attrs):
        if ("targetType" in attrs) != ("targetId" in attrs):
            raise ValidationError("人物或关系目标须同时填写类型和 ID。")
        source = attrs.get("sourceUrl", "")
        if source:
            try:
                url = urlsplit(source)
            except ValueError as exc:
                raise ValidationError({"sourceUrl": "来源链接无效。"}) from exc
            if url.scheme not in ("http", "https") or url.username or url.password:
                raise ValidationError({"sourceUrl": "来源链接须为无账号密码的 HTTP 或 HTTPS 地址。"})
            serializers.URLField(max_length=1500).run_validation(source)
        return attrs


def identity_key(request):
    # 只在直连地址显式受信任时采用代理追加的最后一个转发地址。
    identity = request.META.get("REMOTE_ADDR", "unknown")
    if identity in settings.FEEDBACK_TRUSTED_PROXY_IPS:
        forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[-1].strip()
        try:
            identity = str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    return salted_hmac("atlas-feedback-ip", identity, algorithm="sha256").hexdigest()


@method_decorator([feedback_request_guard, csrf_protect], name="dispatch")
class FeedbackView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    parser_classes = (JSONParser,)
    throttle_classes = ()
    http_method_names = ("post", "options")

    def post(self, request):
        fields = FeedbackInput(data=request.data)
        fields.is_valid(raise_exception=True)
        values = fields.validated_data
        if values.pop("website", ""):
            return Response(CONFIRMATION, status=202)
        target = {}
        if "targetType" in values:
            _, target = get_target(values)
        now = timezone.now()
        key = identity_key(request)
        receipt_key = salted_hmac(
            "atlas-feedback-duplicate", key + json.dumps(values, sort_keys=True, ensure_ascii=False),
            algorithm="sha256",
        ).hexdigest()
        expires = now + timedelta(hours=24)
        with transaction.atomic():
            # 查询已有记录时立即加锁，避免清理任务在查询和加锁之间删除过期行。
            guard, _ = FeedbackGuard.objects.select_for_update().get_or_create(key=key, defaults={
                "window_started": now, "expires_at": expires,
            })
            if now >= guard.window_started + timedelta(hours=1):
                guard.window_started, guard.count = now, 0
            if guard.count >= settings.FEEDBACK_RATE_PER_HOUR:
                raise Throttled(wait=max(1, int((guard.window_started + timedelta(hours=1) - now).total_seconds())))
            guard.count += 1
            guard.expires_at = expires
            guard.save(update_fields=["window_started", "count", "expires_at"])
            if not FeedbackReceipt.objects.filter(pk=receipt_key, expires_at__gt=now).exists():
                Feedback.objects.create(
                    type=values["type"], description=values["description"],
                    source_url=values.get("sourceUrl", ""), contact=values.get("contact", ""), **target,
                )
                FeedbackReceipt.objects.update_or_create(key=receipt_key, defaults={"expires_at": expires})
        return Response(CONFIRMATION, status=202)
