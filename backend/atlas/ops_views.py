import json
from pathlib import Path

from django.conf import settings
from django.db import DatabaseError, connection
from django.db.migrations.executor import MigrationExecutor
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .public_data import consistent_read, release_metadata


@consistent_read
def readiness():
    executor = MigrationExecutor(connection)
    if executor.migration_plan(executor.loader.graph.leaf_nodes()):
        return Response({"status": "not_ready", "reason": "migrations_pending"}, status=503)
    release = release_metadata()
    if release is None:
        return Response({"status": "not_ready", "reason": "data_release_missing"}, status=503)
    assets = json.loads(Path(settings.ASSET_MANIFEST_PATH).read_text())
    if release["assetVersion"] != assets["version"]:
        return Response({"status": "not_ready", "reason": "asset_version_mismatch"}, status=503)
    return Response({"status": "ready", "dataRelease": release})


class ReadyView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = ()

    def get(self, request):
        try:
            return readiness()
        except DatabaseError:
            return Response({"status": "not_ready", "reason": "database_unavailable"}, status=503)
        except (OSError, ValueError, KeyError, TypeError):
            return Response({"status": "not_ready", "reason": "asset_manifest_unavailable"}, status=503)
