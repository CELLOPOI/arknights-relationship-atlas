"""按不可变发布版本缓存已编码的公开 JSON；不写数据库缓存表。"""

from django.core.cache.backends.locmem import LocMemCache
from django.http import HttpResponse, HttpResponseNotModified, JsonResponse
from django.utils.http import parse_etags

# 每个 worker 独立、最多八份响应；发布只更换键，不依赖跨进程清空。
responses = LocMemCache("atlas-public-json", {"TIMEOUT": 86400, "OPTIONS": {"MAX_ENTRIES": 8}})


def encode_json(value):
    return JsonResponse(value, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")}).content


def public_json(request, key, build):
    etag = f'"{key}"'
    validators = parse_etags(request.headers.get("If-None-Match", ""))
    if "*" in validators or etag in [value.removeprefix("W/") for value in validators]:
        response = HttpResponseNotModified()
    else:
        content = responses.get(key)
        if content is None:
            content = build()
            responses.set(key, content)
        response = HttpResponse(content, content_type="application/json")
    response["ETag"] = etag
    response["Cache-Control"] = "public, max-age=0, must-revalidate"
    return response
