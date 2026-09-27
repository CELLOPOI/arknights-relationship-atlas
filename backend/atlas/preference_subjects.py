"""同一人物下的独立人气对象；来源实例不自动成为一个新形态。"""

SUPPORT_ALIASES = {
    "char_512_aprot": "char_4025_aprot2", "char_608_acpion": "char_513_apionr",
    "char_609_acguad": "char_508_aguard", "char_611_acnipe": "char_511_asnipe",
    "char_612_accast": "char_509_acast", "char_613_acmedc": "char_510_amedic",
}


def subjects(catalog):
    people = {p["id"]: p for p in catalog["persons"] if p.get("eligible", True)}
    form_owners = {f["person_id"] for f in catalog["forms"]}
    forms = {f["id"]: f for f in catalog["forms"] if f.get("eligible", True) and f["person_id"] in people}
    art = {a["id"]: a for a in catalog["appearances"] if a.get("eligible", True)}
    result, represented = {}, set()
    for form in forms.values():
        canonical = forms.get(SUPPORT_ALIASES.get(form["id"]))
        if (canonical and canonical.get("complete") and canonical.get("default_appearance_id") in art
                and canonical["person_id"] == form["person_id"] and canonical["profession"] == form["profession"]):
            continue
        person = people[form["person_id"]]
        image = art.get(form.get("default_appearance_id"), {}).get("image_url") or form.get("representative_url")
        if not image:
            continue
        sid = f"form:{form['id']}"
        result[sid] = {**person, "id": sid, "person_id": person["id"], "form_id": form["id"],
                       "name": form["name"], "representative_url": image}
        represented.add(person["id"])
    for pid, person in people.items():
        if pid not in represented and pid not in form_owners:
            sid = f"person:{pid}"
            result[sid] = {**person, "id": sid, "person_id": pid, "form_id": None}
    return result


def project_comparisons(rows, scope, valid_subjects):
    """人物字段保持原始语义；只有明确记录双方形态的新题可以进入形态榜。"""
    for row in rows:
        if scope == "person":
            yield row
            continue
        left, right = row.get("left_subject_id"), row.get("right_subject_id")
        if left not in valid_subjects or right not in valid_subjects:
            continue
        if (valid_subjects[left]["person_id"] != row["left_id"]
                or valid_subjects[right]["person_id"] != row["right_id"]):
            continue
        winner = left if row["winner_id"] == row["left_id"] else right if row["winner_id"] == row["right_id"] else ""
        yield {**row, "left_id": left, "right_id": right, "winner_id": winner}
