from django.db import models


class AdminLoginGuard(models.Model):
    key = models.CharField(primary_key=True, max_length=64)
    window_started = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        default_permissions = ()
