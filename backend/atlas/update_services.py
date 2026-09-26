from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.utils import timezone

from .update_models import SiteUpdate


@transaction.atomic
def set_update_publication(pk, *, actor, published):
    if not actor.is_active or not actor.is_staff or not actor.has_perm("atlas.publish_siteupdate"):
        raise PermissionDenied("需要更新说明发布权限。")
    update = SiteUpdate.objects.select_for_update().get(pk=pk)
    target = SiteUpdate.Status.PUBLISHED if published else SiteUpdate.Status.DRAFT
    if update.status == target:
        return update
    update.status = target
    if published and update.published_at is None:
        update.published_at = timezone.now()
    update.full_clean()
    update.version += 1
    update.save()
    return update
