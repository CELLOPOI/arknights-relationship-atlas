from django.core.paginator import EmptyPage, Paginator
from django.shortcuts import get_object_or_404
from django.utils.cache import patch_cache_control
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from .update_models import SiteUpdate


def public_fields(update):
    return {"id": update.pk, "category": update.category, "title": update.title, "summary": update.summary,
            "changes": [line.strip() for line in update.changes.splitlines() if line.strip()],
            "status": update.status,
            "publishedAt": update.published_at.isoformat() if update.published_at else None}


class SiteUpdatesView(APIView):
    permission_classes = (permissions.AllowAny,)

    def get(self, request):
        category = request.query_params.get("category", "all")
        page_number = request.query_params.get("page", "1")
        if category not in ("all", *SiteUpdate.Category.values) or not page_number.isdecimal() or len(page_number) > 6:
            return Response({"detail": "更新说明筛选或页码无效。"}, status=400)
        updates = SiteUpdate.objects.filter(status=SiteUpdate.Status.PUBLISHED)
        if category != "all":
            updates = updates.filter(category=category)
        paginator = Paginator(updates, 20)
        try:
            page = paginator.page(int(page_number))
        except EmptyPage:
            return Response({"detail": "更新说明页码不存在。"}, status=404)
        response = Response({"results": [public_fields(item) for item in page], "count": paginator.count,
                             "next": page.next_page_number() if page.has_next() else None})
        patch_cache_control(response, no_cache=True)
        return response


class SiteUpdatePreviewView(APIView):
    permission_classes = (permissions.IsAdminUser,)

    def get(self, request, pk):
        if not request.user.has_perm("atlas.view_siteupdate"):
            return Response({"detail": "需要查看更新说明权限。"}, status=403)
        update = get_object_or_404(SiteUpdate, pk=pk)
        response = Response(public_fields(update))
        patch_cache_control(response, private=True, no_store=True)
        return response
