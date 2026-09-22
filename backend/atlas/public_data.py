"""公开资料读取在一次数据库快照中完成，避免发布切换时混合两个版本。"""

from functools import wraps

from django.db import connection, transaction

from .release_models import ReleaseState


def consistent_read(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        # 已有事务的调用者负责自己的隔离级别；正常 HTTP GET 不开启 ATOMIC_REQUESTS。
        if connection.in_atomic_block:
            return view(*args, **kwargs)
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            return view(*args, **kwargs)
    return wrapped


def release_metadata():
    row = ReleaseState.objects.filter(pk=1).values(
        "current_id", "current__manifest__data_digest", "current__manifest__git_commit",
        "current__manifest__asset_version", "current__origin",
    ).first()
    if not row or not row["current_id"]:
        return None
    return {"id": row["current_id"], "dataDigest": row["current__manifest__data_digest"],
            "gitCommit": row["current__manifest__git_commit"], "assetVersion": row["current__manifest__asset_version"],
            "origin": row["current__origin"]}
