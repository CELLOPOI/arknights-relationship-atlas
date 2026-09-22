import hashlib
import json

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction

from .models import (
    Evidence,
    Faction,
    Identity,
    ImportBatch,
    Person,
    Relationship,
    validate_aliases,
    validate_sources,
)
from .services import record_revision, snapshot


def validate_bundle(graph, evidence):
    if not isinstance(graph, dict) or any(
        not isinstance(graph.get(k), list) for k in ("nodes", "edges", "factions")
    ):
        raise ValidationError("图谱文件必须包含 nodes、edges、factions 列表。")
    if not isinstance(evidence, dict):
        raise ValidationError("证据文件必须是以关系 ID 为键的对象。")
    if len(graph["nodes"]) > 30000 or len(graph["edges"]) > 150000:
        raise ValidationError("此导入超过单批处理上限，请拆分批次。")
    try:
        for key in ("nodes", "edges", "factions"):
            ids = [x["id"] for x in graph[key]]
            if any(not isinstance(x, str) or not x for x in ids) or len(ids) != len(set(ids)):
                raise ValidationError(f"{key} 中有空 ID 或重复 ID。")
        people = {n["id"] for n in graph["nodes"]}
        factions = {f["id"] for f in graph["factions"]}
        pairs = set()
        for node in graph["nodes"]:
            if (
                node["factionId"] not in factions
                or not isinstance(node["name"], str)
                or not node["name"].strip()
            ):
                raise ValidationError("人物姓名或阵营无效。")
            validate_aliases(node.get("aliases", []))
            if type(node.get("isOperator", True)) is not bool:
                raise ValidationError("isOperator 必须是布尔值。")
            if type(node.get("avatarIsGeneric", False)) is not bool:
                raise ValidationError("avatarIsGeneric 必须是布尔值。")
        for edge in graph["edges"]:
            a, b = edge["source"], edge["target"]
            pair = tuple(sorted((a, b)))
            if a not in people or b not in people or a == b or pair in pairs:
                raise ValidationError("关系有未知人物、自环或重复人物对。")
            pairs.add(pair)
            if edge["kind"] not in {"mutual", "awareness"}:
                raise ValidationError("未知关系判定。")
            if edge["kind"] == "awareness":
                if edge.get("from") not in pair or edge.get("to") not in pair or edge["from"] == edge["to"]:
                    raise ValidationError("单向知晓必须指定不同且有效的 from/to。")
            elif edge.get("from") or edge.get("to"):
                raise ValidationError("确认相识不能附带单向知晓方向。")
            item = evidence[edge["id"]]
            if (
                not isinstance(item.get("quote"), str)
                or not item["quote"].strip()
                or not isinstance(item.get("note", ""), str)
            ):
                raise ValidationError("证据原文及判定说明必须是文本。")
            validate_sources(item.get("sources", []))
        if set(evidence) != {e["id"] for e in graph["edges"]}:
            raise ValidationError("证据和关系 ID 必须一一对应。")
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValidationError("导入字段缺失或类型错误。") from exc


@transaction.atomic
def import_bundle(graph, evidence, *, actor=None, dry_run=False, update_existing=False):
    if settings.FORMAL_DATA_MANAGED and not dry_run:
        raise ValidationError("正式资料仅通过版本化发布写入；旧导入入口已关闭。")
    validate_bundle(graph, evidence)
    digest = hashlib.sha256(
        json.dumps([graph, evidence], ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    summary = {
        "people": len(graph["nodes"]),
        "relationships": len(graph["edges"]),
        "awareness": sum(e["kind"] == "awareness" for e in graph["edges"]),
        "created": 0,
        "updated": 0,
        "unchanged": 0,
        "digest": digest,
    }
    if ImportBatch.objects.filter(digest=digest).exists():
        return {**summary, "already_imported": True}

    def persist(model, key, values):
        obj = model.objects.select_for_update().filter(pk=key).first()
        before = snapshot(obj) if obj else {}
        if obj and all(getattr(obj, field) == value for field, value in values.items()):
            summary["unchanged"] += 1
            return obj
        if obj and not update_existing:
            raise ValidationError(
                f"{model._meta.verbose_name} {key} 已存在且内容不同；请先预览并明确选择更新已有资料。"
            )
        if obj:
            for field, value in values.items():
                setattr(obj, field, value)
            if hasattr(obj, "version"):
                obj.version += 1
            summary["updated"] += 1
        else:
            obj = model(pk=key, **values)
            summary["created"] += 1
        obj.full_clean()
        obj.save()
        record_revision(obj, actor, before, f"import:{digest[:16]}")
        return obj

    for row in graph["factions"]:
        persist(Faction, row["id"], {"name": row["name"], "order": row.get("order", 999)})
    for row in graph["nodes"]:
        person = persist(
            Person,
            row["id"],
            {
                "name": row["name"],
                "aliases": row.get("aliases", []),
                "faction_id": row["factionId"],
                "group_id": row.get("groupId", ""),
                "group_name": row.get("groupName", ""),
                "is_operator": row.get("isOperator", True),
                "avatar": row.get(
                    "avatar", f"/avatars/{row['id']}.webp" if row.get("isOperator", True) else ""
                ),
                "avatar_source": row.get("avatarSource", ""),
                "avatar_is_generic": row.get("avatarIsGeneric", False),
            },
        )
        if person.id.startswith("char_"):
            identity, _ = Identity.objects.get_or_create(
                external_id=person.id, defaults={"person": person, "label": person.name}
            )
            if identity.person_id != person.id:
                raise ValidationError("外部身份 ID 已关联其他人物。")
    for row in graph["edges"]:
        a, b = sorted((row["source"], row["target"]))
        item = evidence[row["id"]]
        relation = persist(
            Relationship,
            row["id"],
            {
                "person_a_id": a,
                "person_b_id": b,
                "kind": row["kind"],
                "awareness_from_id": row.get("from") if row["kind"] == "awareness" else None,
                "note": item.get("note", ""),
                "stable_keys": row.get("stableKeys", [row["id"]]),
            },
        )
        saved = Evidence.objects.filter(import_key=row["id"]).first()
        values = {"quote": item["quote"], "sources": item.get("sources", [])}
        if saved and any(getattr(saved, k) != v for k, v in values.items()) and not update_existing:
            raise ValidationError("已导入证据发生变化，请明确选择更新已有资料。")
        if saved and all(getattr(saved, k) == v for k, v in values.items()):
            continue
        before = snapshot(saved) if saved else {}
        if saved:
            saved.quote, saved.sources = values["quote"], values["sources"]
        else:
            saved = Evidence(relationship=relation, import_key=row["id"], **values)
        saved.full_clean()
        saved.save()
        record_revision(saved, actor, before, f"import:{digest[:16]}")
        if before:
            relation_before = snapshot(relation)
            relation.version += 1
            relation.save(update_fields=["version", "updated_at"])
            record_revision(relation, actor, relation_before, f"import:evidence:{digest[:16]}")
    ImportBatch.objects.create(digest=digest, actor=actor, summary=summary)
    if dry_run:
        transaction.set_rollback(True)
    return {**summary, "dry_run": dry_run}
