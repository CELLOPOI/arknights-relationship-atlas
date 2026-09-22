"""资料快照 schema 与确定性编译，供初始化、后台校验及导出共用。"""

import hashlib
import json
import re
from pathlib import Path

from django.core.exceptions import ValidationError

from .models import Evidence, Faction, Identity, Person, Relationship, validate_aliases, validate_sources

SCHEMA_VERSION = 1
FIELDS = {
    "factions": ("id", "name", "order"),
    "people": (
        "id", "name", "aliases", "faction_id", "group_id", "group_name", "is_operator",
        "avatar", "avatar_source", "avatar_is_generic", "published",
    ),
    "identities": ("external_id", "person_id", "label", "published"),
    "relationships": (
        "id", "person_a_id", "person_b_id", "kind", "awareness_from_id", "note", "stable_keys", "published",
    ),
    "evidence": ("id", "relationship_id", "quote", "sources", "published"),
}
MODELS = {"factions": Faction, "people": Person, "identities": Identity,
          "relationships": Relationship, "evidence": Evidence}
KEYS = {name: "external_id" if name == "identities" else "id" for name in FIELDS}
SECTIONS = (*FIELDS, "conditional", "provenance")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def digest(value):
    return hashlib.sha256(json_bytes(value)).hexdigest()


def read_json(path):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValidationError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValidationError(f"Invalid JSON constant: {value}")

    try:
        return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique_pairs,
                          parse_constant=invalid_constant)
    except (OSError, ValueError, UnicodeError) as exc:
        raise ValidationError(f"Cannot read JSON: {path}") from exc


def evidence_id(item):
    # 导入键优先，使旧快照和数据库导出拥有相同 ID；独立后台证据保留自身身份。
    return item.source_id or ("import:" + item.import_key if item.import_key else f"database:{item.pk}")


def export_database():
    """调用者负责一致性事务；白名单排除账号、反馈、审核与内部审计。"""
    result = {"schema_version": SCHEMA_VERSION}
    for section, fields in FIELDS.items():
        if section == "evidence":
            result[section] = [
                {"id": evidence_id(e), "relationship_id": e.relationship_id,
                 "quote": e.quote, "sources": e.sources, "published": e.published}
                for e in Evidence.objects.order_by("pk")
            ]
        else:
            result[section] = list(MODELS[section].objects.order_by(KEYS[section]).values(*fields))
    result.update(conditional=[], provenance={})
    return canonical_data(result)


def snapshot_data(directory):
    """只转换当前旧导入器的实际语义，不推断新关系或拆分原文。"""
    from .importing import validate_bundle

    directory = Path(directory)
    graph, evidence = (read_json(directory / f"{name}.json") for name in ("graph", "evidence"))
    validate_bundle(graph, evidence)
    result = {"schema_version": SCHEMA_VERSION, **{key: [] for key in FIELDS}}
    result["factions"] = [{"id": f["id"], "name": f["name"], "order": f.get("order", 999)} for f in graph["factions"]]
    for row in graph["nodes"]:
        result["people"].append({
            "id": row["id"], "name": row["name"], "aliases": row.get("aliases", []),
            "faction_id": row["factionId"], "group_id": row.get("groupId", ""),
            "group_name": row.get("groupName", ""), "is_operator": row.get("isOperator", True),
            "avatar": row.get("avatar", f"/avatars/{row['id']}.webp" if row.get("isOperator", True) else ""),
            "avatar_source": row.get("avatarSource", ""), "avatar_is_generic": row.get("avatarIsGeneric", False),
            "published": True,
        })
        if row["id"].startswith("char_"):
            result["identities"].append({"external_id": row["id"], "person_id": row["id"],
                                         "label": row["name"], "published": True})
    for row in graph["edges"]:
        a, b = sorted((row["source"], row["target"]))
        item = evidence[row["id"]]
        result["relationships"].append({
            "id": row["id"], "person_a_id": a, "person_b_id": b, "kind": row["kind"],
            "awareness_from_id": row.get("from") if row["kind"] == "awareness" else None,
            "note": item.get("note", ""), "stable_keys": row.get("stableKeys", [row["id"]]), "published": True,
        })
        result["evidence"].append({"id": "import:" + row["id"], "relationship_id": row["id"],
                                   "quote": item["quote"], "sources": item.get("sources", []), "published": True})
    result["conditional"] = read_json(directory / "conditional.json")
    result["provenance"] = read_json(directory / "provenance.json")
    return canonical_data(result)


def canonical_data(data):
    validate_data(data)
    return {**data, **{section: sorted(data[section], key=lambda row: row[KEYS[section]]) for section in FIELDS},
            "conditional": sorted(data["conditional"], key=lambda row: row["key"])}


def _require(condition, message):
    if not condition:
        raise ValidationError(message)


def validate_data(data):
    try:
        _validate_data(data)
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise ValidationError("Invalid source field type or structure.") from exc


def _validate_data(data):
    _require(isinstance(data, dict) and set(data) == {"schema_version", *SECTIONS}, "Invalid source sections.")
    _require(type(data["schema_version"]) is int and data["schema_version"] == SCHEMA_VERSION,
             "Unsupported source schema version.")
    indexes = {}
    for section, fields in FIELDS.items():
        rows = data[section]
        _require(isinstance(rows, list), f"{section} must be a list.")
        indexes[section] = {}
        for row in rows:
            _require(isinstance(row, dict) and set(row) == set(fields), f"Invalid fields in {section}.")
            key = row[KEYS[section]]
            _require(isinstance(key, str) and 0 < len(key) <= 250 and key.strip() == key,
                     f"Invalid ID in {section}.")
            _require(key not in indexes[section], f"Duplicate ID in {section}: {key}")
            indexes[section][key] = row
            for name, value in row.items():
                if section == "evidence" and name == "id":
                    continue
                field = MODELS[section]._meta.get_field(name.removesuffix("_id") if name.endswith("_id")
                                                       and name not in ("group_id", "external_id") else name)
                if field.is_relation:
                    _require(value is None and field.null or isinstance(value, str) and bool(value),
                             f"Invalid reference {section}.{name}: {key}")
                    continue
                kind = field.get_internal_type()
                if kind == "BooleanField":
                    _require(type(value) is bool, f"{section}.{name} must be a boolean: {key}")
                elif kind == "IntegerField":
                    _require(type(value) is int, f"{section}.{name} must be an integer: {key}")
                elif kind in ("CharField", "TextField", "URLField"):
                    _require(isinstance(value, str), f"{section}.{name} must be text: {key}")
                field.clean(value, None)
            if section == "people":
                validate_aliases(row["aliases"])
                Person(**row).clean()
            if section == "relationships":
                _require(isinstance(row["stable_keys"], list) and all(isinstance(v, str) and v for v in row["stable_keys"]),
                         f"Invalid stable keys: {key}")
            if section == "evidence":
                _require(bool(row["quote"].strip()), f"Evidence must contain a quote: {key}")
                validate_sources(row["sources"])
    people, relationships = indexes["people"], indexes["relationships"]
    for p in people.values():
        _require(p["faction_id"] in indexes["factions"], f"Unknown faction: {p['id']}")
        _require(bool(p["name"].strip()), f"Person must have a name: {p['id']}")
    for identity in indexes["identities"].values():
        _require(identity["person_id"] in people, f"Unknown identity target: {identity['external_id']}")
    pairs = set()
    for row in relationships.values():
        pair = (row["person_a_id"], row["person_b_id"])
        _require(all(p in people for p in pair) and pair[0] < pair[1] and pair not in pairs,
                 f"Unknown, unordered or duplicate relationship pair: {row['id']}")
        pairs.add(pair)
        _require((row["kind"] == "mutual" and row["awareness_from_id"] is None)
                 or (row["kind"] == "awareness" and row["awareness_from_id"] in pair),
                 f"Invalid awareness direction: {row['id']}")
    supported = set()
    public_supported = set()
    for row in indexes["evidence"].values():
        _require(row["relationship_id"] in relationships, f"Unknown evidence relationship: {row['id']}")
        supported.add(row["relationship_id"])
        if row["published"]:
            public_supported.add(row["relationship_id"])
    _require(supported == set(relationships), "Every relationship must have independent evidence.")
    _require({r["id"] for r in relationships.values() if r["published"]} <= public_supported,
             "Every published relationship must have published evidence.")
    _require(isinstance(data["conditional"], list), "Conditional narratives must be a list.")
    condition_keys = set()
    for row in data["conditional"]:
        _require(isinstance(row, dict) and set(row) == {
            "key", "personIds", "names", "realityScope", "groupId", "contributions"
        } and isinstance(row.get("key"), str)
                 and row.get("realityScope") in {"hypothetical_ending_branch", "fictional_film"},
                 "Invalid conditional narrative.")
        _require(row["key"] not in condition_keys, "Duplicate conditional narrative.")
        condition_keys.add(row["key"])
        _require(isinstance(row.get("personIds"), list) and len(row["personIds"]) == 2
                 and all(isinstance(p, str) for p in row["personIds"])
                 and len(set(row["personIds"])) == 2 and all(p in people for p in row["personIds"]),
                 "Invalid conditional person references.")
        _require(isinstance(row["names"], list) and len(row["names"]) == 2
                 and all(isinstance(n, str) and n for n in row["names"])
                 and isinstance(row["groupId"], str) and bool(row["groupId"]), "Invalid conditional names or group.")
        _validate_contributions(row["contributions"], row["personIds"], conditional=row)
        # 条件分支和现实关系可具有同一人物对，但条件证据绝不能自动编译为现实关系。
    _require(isinstance(data["provenance"], dict) and set(data["provenance"]) <= set(relationships),
             "Unknown provenance relationship.")
    for key, contributions in data["provenance"].items():
        row = relationships[key]
        _validate_contributions(contributions, [row["person_a_id"], row["person_b_id"]])


def _validate_contributions(contributions, people, *, conditional=None):
    _require(isinstance(contributions, list) and bool(contributions), "Contributions must be a nonempty list.")
    common = {"title", "description", "temporalScope", "resultPath", "directions"}
    for item in contributions:
        required = common | ({"assignmentId", "groupId", "key", "label", "personIds", "realityScope"}
                             if conditional else {"citations", "sources"})
        _require(isinstance(item, dict) and required <= set(item)
                 and set(item) <= required | ({"manualCaseId"} if not conditional else set()),
                 "Invalid contribution fields.")
        text_fields = set(item) - {"directions", "personIds", "citations", "sources"}
        _require(all(isinstance(item[k], str) for k in text_fields), "Contribution metadata must be text.")
        if conditional:
            _require(all(item[k] == conditional[k] for k in ("key", "groupId", "personIds", "realityScope")),
                     "Conditional contribution scope or target mismatch.")
        else:
            validate_sources(item["sources"])
            _require(isinstance(item["citations"], list), "Citations must be a list.")
            for citation in item["citations"]:
                _require(isinstance(citation, dict) and set(citation) == {"path", "line", "endLine", "quote"},
                         "Invalid citation fields.")
                _require(isinstance(citation["quote"], str) and bool(citation["quote"].strip()), "Invalid citation quote.")
                validate_sources([{"kind": "story", "source": citation["path"], "line": citation["line"],
                                   "endLine": citation["endLine"]}])
        _require(isinstance(item["directions"], list) and bool(item["directions"]), "Invalid contribution directions.")
        for direction in item["directions"]:
            required_direction = {"from", "to", "status", "evidenceIds"}
            _require(isinstance(direction, dict) and required_direction <= set(direction)
                     and set(direction) <= required_direction | {"reason"}, "Invalid contribution direction fields.")
            _require(isinstance(direction["from"], str) and isinstance(direction["to"], str)
                     and {direction["from"], direction["to"]} == set(people), "Invalid contribution endpoints.")
            _require(direction["status"] in ("supported", "not_established", "not_established_in_batch")
                     and isinstance(direction.get("reason", ""), str), "Invalid contribution direction status.")
            _require(isinstance(direction["evidenceIds"], list)
                     and all(isinstance(e, str) and e for e in direction["evidenceIds"]), "Invalid evidence IDs.")


def compare_data(before, after):
    """逐字段差异，仅涉及正式资料白名单。"""
    changes = []
    for section in FIELDS:
        key = KEYS[section]
        old = {x[key]: x for x in before[section]}
        new = {x[key]: x for x in after[section]}
        for identity in sorted(old.keys() | new.keys()):
            if old.get(identity) != new.get(identity):
                changes.append({"section": section, "id": identity,
                                "before": old.get(identity), "after": new.get(identity)})
    return changes


def source_filename(section, key):
    # 全部使用固定前缀与完整摘要，避免 Windows 保留名、大小写冲突和关系 ID 中的竖线。
    return f"{section}/record-{hashlib.sha256(key.encode()).hexdigest()}.json"


def write_source(data, directory, *, metadata):
    data = canonical_data(data)
    directory = Path(directory)
    if directory.exists():
        raise ValidationError("Source output already exists; refusing to overwrite reviewed data.")
    files = source_records(data, metadata)
    directory.mkdir(parents=True)
    for name, value in sorted(files.items()):
        path = directory / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(json_bytes(value))


def source_records(data, metadata):
    files = {"manifest.json": {"schema_version": SCHEMA_VERSION, "metadata": metadata}}
    for section in FIELDS:
        for row in data[section]:
            files[source_filename(section, row[KEYS[section]])] = row
    for row in data["conditional"]:
        files[source_filename("conditional", row["key"])] = row
    for key, contributions in data["provenance"].items():
        files[source_filename("provenance", key)] = {"relationship_id": key, "contributions": contributions}
    return files


def load_source(directory):
    directory = Path(directory)
    _require(not directory.is_symlink() and not (directory / "manifest.json").is_symlink(),
             "Source must not contain symbolic links.")
    manifest = read_json(directory / "manifest.json")
    _require(isinstance(manifest, dict) and set(manifest) == {"schema_version", "metadata"}
             and isinstance(manifest["metadata"], dict), "Invalid source manifest.")
    data = {"schema_version": manifest["schema_version"], **{s: [] for s in SECTIONS}}
    data["provenance"] = {}
    files = {"manifest.json": digest(manifest)}
    for path in sorted(directory.rglob("*")):
        _require(not path.is_symlink(), "Source must not contain symbolic links.")
        if path.is_dir():
            _require(path.parent == directory and path.name in SECTIONS, f"Unknown source directory: {path}")
            continue
        name = path.relative_to(directory).as_posix()
        if name == "manifest.json":
            continue
        _require(path.parent.name in SECTIONS and path.parent.parent == directory
                 and re.fullmatch(r"record-[0-9a-f]{64}\.json", path.name), f"Unknown source file: {name}")
        section = path.parent.name
        row = read_json(path)
        _require(isinstance(row, dict), f"Invalid source record: {name}")
        key = row.get("key" if section == "conditional" else "relationship_id" if section == "provenance"
                      else KEYS[section])
        _require(isinstance(key, str) and source_filename(section, key) == name, f"Record filename mismatch: {name}")
        if section == "provenance":
            _require(set(row) == {"relationship_id", "contributions"}, "Invalid provenance fields.")
            data[section][key] = row["contributions"]
        else:
            data[section].append(row)
        files[name] = digest(row)
    # 保持条件条目的稳定次序，不让遍历文件系统的顺序影响发布摘要。
    data["conditional"].sort(key=lambda row: row["key"])
    return canonical_data(data), {"schema_version": SCHEMA_VERSION, "files": files,
                                  "source_digest": digest(files), "metadata": manifest["metadata"]}


def compile_graph(data, *, scope="all"):
    _require(scope in ("all", "operators"), "Invalid graph scope.")
    factions = {f["id"]: f for f in data["factions"]}
    people = [p for p in data["people"] if p["published"] and (scope == "all" or p["is_operator"])]
    people_ids = {p["id"] for p in people}
    nodes = []
    for p in people:
        nodes.append({
            "id": p["id"], "name": p["name"], "aliases": p["aliases"],
            "factionId": p["faction_id"], "factionName": factions[p["faction_id"]]["name"],
            "isOperator": p["is_operator"], "avatar": p["avatar"] or "/avatars/unknown.svg",
            "avatarSource": p["avatar_source"], "avatarIsGeneric": p["avatar_is_generic"],
            **({"groupId": p["group_id"], "groupName": p["group_name"]} if p["group_id"] else {}),
        })
    edges = []
    for r in data["relationships"]:
        if not r["published"] or not {r["person_a_id"], r["person_b_id"]} <= people_ids:
            continue
        edge = {"id": r["id"], "source": r["person_a_id"], "target": r["person_b_id"],
                "kind": r["kind"], "stableKeys": r["stable_keys"]}
        if r["kind"] == "awareness":
            edge.update({"from": r["awareness_from_id"], "to": r["person_b_id"]
                         if r["awareness_from_id"] == r["person_a_id"] else r["person_a_id"]})
        edges.append(edge)
    faction_ids = {p["faction_id"] for p in people}
    return {"nodes": nodes, "edges": edges,
            "factions": sorted((f for f in factions.values() if f["id"] in faction_ids), key=lambda f: (f["order"], f["id"])),
            "scope": scope, "npcCount": sum(not p["is_operator"] and p["published"] for p in data["people"])}


def compile_source(directory):
    data, manifest = load_source(directory)
    graph = compile_graph(data)
    return {"data": data, "graph": graph, "manifest": {
        **manifest, "data_digest": digest(data), "graph_digest": digest(graph),
        "counts": {section: len(data[section]) for section in SECTIONS},
    }}
