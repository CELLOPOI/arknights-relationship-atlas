"""后台展示业务名称；稳定 ID 和原始值仍保留在资料快照中。"""

import json


def field_value(section, key, value, data):
    if value is None:
        return "无"
    if isinstance(value, bool):
        return "是" if value else "否"
    if key == "kind":
        return {"mutual": "确认相识", "awareness": "单向知晓"}.get(value, value)
    if key == "sources":
        kinds = {"story": "剧情", "profile": "档案", "manual": "人工说明"}
        return "\n".join(
            f"{kinds.get(row['kind'], row['kind'])} · {row['source']}"
            + (f" · 行 {row['line']}" + (f"–{row['endLine']}" if row.get("endLine") else "") if row.get("line") else "")
            + (f" · 版本 {row['version']}" if row.get("version") else "") for row in value
        ) or "未填写来源"
    if key in ("aliases", "stable_keys"):
        return "\n".join(value) or "无"
    if key in ("person_a_id", "person_b_id", "person_id", "awareness_from_id", "faction_id", "relationship_id"):
        target = "factions" if key == "faction_id" else "relationships" if key == "relationship_id" else "people"
        row = next((row for row in data[target] if row["id"] == value), None)
        if row:
            return f"{record_name(target, row, data)}（{value}）"
    if isinstance(value, str):
        return value or "空"
    return json.dumps(value, ensure_ascii=False, indent=2)


def record_name(section, row, data):
    if section == "relationships":
        people = {row["id"]: row["name"] for row in data["people"]}
        return f"{people.get(row['person_a_id'], '待选人物')} / {people.get(row['person_b_id'], '待选人物')}"
    if section == "evidence":
        return row["quote"][:60] or "待填写原文"
    return row.get("name") or row.get("label") or row.get("external_id", "")


def error_message(exc):
    return "；".join(exc.messages).replace(
        "Every relationship must have independent evidence.", "每条关系都需要独立证据，请在本次修订中添加原文和来源。"
    ).replace(
        "Every published relationship must have published evidence.", "公开关系至少需要一条公开证据，请核对证据的公开状态。"
    )
