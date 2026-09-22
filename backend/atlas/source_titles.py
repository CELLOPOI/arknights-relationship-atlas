"""Resolve readable source names without changing published evidence or its digest."""

import json
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def source_catalog():
    return json.loads((Path(__file__).parent / "data" / "source-titles.json").read_text(encoding="utf-8"))


def source_key(source):
    location = source.get("source", "")
    if source.get("kind") == "story":
        for prefix in ("ArknightsGameData/zh_CN/gamedata/story/", "zh_CN/gamedata/story/"):
            if location.startswith(prefix):
                location = location[len(prefix):]
                break
        location = location.lower().removesuffix(".txt")
    return f"{source.get('kind', '')}:{location}"


def describe_source(source):
    catalog = source_catalog()
    version = source.get("version")
    # 不把其他版本的同名路径自动当作本版出处。无版本的旧引用使用已核对的基线索引。
    if source.get("kind") != "manual" and version and version != catalog["sourceCommit"]:
        return dict(source)
    entry = catalog["entries"].get(source_key(source))
    if entry is None:
        return dict(source)
    result = {**source, "title": entry["title"]}
    for key in ("referenceUrl", "referenceLabel"):
        if key in entry:
            result[key] = entry[key]
    return result
