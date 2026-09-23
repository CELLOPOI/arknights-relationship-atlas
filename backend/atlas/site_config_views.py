import re

from django.conf import settings
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


class SiteConfigView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = ()

    def get(self, request):
        token = settings.CLOUDFLARE_WEB_ANALYTICS_TOKEN
        if settings.DEBUG or not re.fullmatch(r"[a-fA-F0-9]{32}", token):
            token = ""
        # 只公开网页统计所需的站点标识，不能扩展成环境变量或服务端配置转储。
        return Response({"cloudflareWebAnalyticsToken": token}, headers={"Cache-Control": "no-store"})
