"""喜好业务独立存储；不写入受保护的正式人物资料。"""
import uuid
from typing import ClassVar

from django.conf import settings
from django.db import models
from django.utils import timezone


class PreferenceParticipant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    credential_hash = models.CharField(max_length=64, unique=True)
    risk_status = models.CharField(max_length=16, default="accepted")
    created_at = models.DateTimeField(auto_now_add=True)
    support_ids = models.JSONField(default=list)
    favorite_ids = models.JSONField(default=list)
    subject_support_ids = models.JSONField(default=list)
    subject_favorite_ids = models.JSONField(default=list)
    support_version = models.PositiveIntegerField(default=0)
    support_modified_at = models.DateTimeField(null=True)

    class Meta:
        verbose_name = "喜好参与标识"
        permissions: ClassVar = [("review_preference_risk", "Can review preference risk")]


class PreferenceCatalog(models.Model):
    version = models.CharField(max_length=120, primary_key=True)
    payload = models.JSONField()
    digest = models.CharField(max_length=64)
    status = models.CharField(max_length=16, default="draft")
    base_version = models.CharField(max_length=120, blank=True)
    note = models.TextField(blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="preference_catalogs")
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="preference_reviews")
    created_at = models.DateTimeField(auto_now_add=True)
    published_at = models.DateTimeField(null=True)

    class Meta:
        verbose_name = "喜好候选名录"
        permissions: ClassVar = [("review_preference_catalog", "Can review preference catalog"),
                                ("publish_preference_catalog", "Can publish preference catalog")]


class PreferenceControl(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    catalog = models.ForeignKey(PreferenceCatalog, on_delete=models.PROTECT, null=True)
    reads_enabled = models.BooleanField(default=True)
    writes_enabled = models.BooleanField(default=True)
    tasks_enabled = models.BooleanField(default=True)
    supports_enabled = models.BooleanField(default=True)
    choices_enabled = models.BooleanField(default=True)
    paused_objects = models.JSONField(default=list)
    revision = models.PositiveIntegerField(default=0)
    last_aggregation_at = models.DateTimeField(null=True)
    aggregation_error = models.TextField(blank=True)
    retained_since = models.DateTimeField(null=True)

    class Meta:
        verbose_name = "喜好运行开关"


class PreferenceTask(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participant = models.ForeignKey(PreferenceParticipant, on_delete=models.CASCADE)
    catalog = models.ForeignKey(PreferenceCatalog, on_delete=models.PROTECT)
    left_id = models.CharField(max_length=220)
    right_id = models.CharField(max_length=220)
    left_subject_id = models.CharField(max_length=240, blank=True)
    right_subject_id = models.CharField(max_length=240, blank=True)
    pair_key = models.CharField(max_length=490)
    strategy = models.CharField(max_length=40)
    status = models.CharField(max_length=16, default="pending")
    issued_at = models.DateTimeField(db_index=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, db_index=True)
    outcome = models.CharField(max_length=16, blank=True)
    winner_id = models.CharField(max_length=220, blank=True)
    risk_status = models.CharField(max_length=16, default="accepted")
    void_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints: ClassVar = [models.UniqueConstraint(fields=["participant"], condition=models.Q(status="pending"),
                                                        name="preference_one_pending_task"),
                                models.CheckConstraint(condition=~models.Q(left_id=models.F("right_id")),
                                                       name="preference_distinct_people")]
        indexes: ClassVar = [models.Index(fields=["participant", "issued_at"])]


class PreferenceChoice(models.Model):
    participant = models.ForeignKey(PreferenceParticipant, on_delete=models.CASCADE)
    kind = models.CharField(max_length=8)
    object_id = models.CharField(max_length=220)
    choice_id = models.CharField(max_length=220, blank=True)
    action = models.CharField(max_length=16, default="withdraw")
    catalog_version = models.CharField(max_length=120, blank=True)
    version = models.PositiveIntegerField(default=0)
    modified_at = models.DateTimeField(null=True)

    class Meta:
        constraints: ClassVar = [models.UniqueConstraint(fields=["participant", "kind", "object_id"],
                                                        name="preference_one_current_choice")]


class PreferenceOperation(models.Model):
    participant = models.ForeignKey(PreferenceParticipant, on_delete=models.CASCADE)
    key = models.CharField(max_length=100)
    digest = models.CharField(max_length=64)
    response = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints: ClassVar = [models.UniqueConstraint(fields=["participant", "key"], name="preference_operation_unique")]


class PreferenceEvent(models.Model):
    participant = models.ForeignKey(PreferenceParticipant, on_delete=models.CASCADE, null=True)
    kind = models.CharField(max_length=40)
    object_id = models.CharField(max_length=220, blank=True)
    before = models.JSONField(default=dict)
    after = models.JSONField(default=dict)
    reason = models.TextField(blank=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)


class PreferenceRiskSignal(models.Model):
    participant = models.ForeignKey(PreferenceParticipant, on_delete=models.CASCADE, null=True)
    source_hash = models.CharField(max_length=64, db_index=True)
    signal = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)


class PreferenceRate(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    window_started = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)


class PreferenceSnapshot(models.Model):
    scope = models.CharField(max_length=12, default="person")
    kind = models.CharField(max_length=12)
    object_id = models.CharField(max_length=220, blank=True)
    window = models.PositiveIntegerField(default=0)
    cutoff = models.DateTimeField(db_index=True)
    generated_at = models.DateTimeField(auto_now_add=True)
    catalog_version = models.CharField(max_length=120)
    algorithm_version = models.CharField(max_length=100)
    asset_version = models.CharField(max_length=120)
    revision = models.PositiveIntegerField(default=0)
    payload = models.JSONField()
    supersedes = models.ForeignKey("self", on_delete=models.PROTECT, null=True)
    reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints: ClassVar = [models.UniqueConstraint(fields=["scope", "kind", "object_id", "window", "cutoff", "catalog_version", "algorithm_version", "revision"],
                                                        name="preference_snapshot_run_unique")]
        ordering: ClassVar = ["-cutoff", "-revision", "-pk"]
