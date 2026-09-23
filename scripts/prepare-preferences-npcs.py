"""生成逐剧情NPC审读材料；名字匹配只形成候选，入选必须另行审读确认。"""
import argparse
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--npc-catalog", type=Path, required=True)
    parser.add_argument("--stories", type=Path, required=True)
    parser.add_argument("--story-tree", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    metadata = json.loads((root / "data/preferences/metadata.json").read_text())
    raw = args.npc_catalog.read_bytes()
    catalog = json.loads(raw)
    tree = {line.split("\t")[1].removeprefix("zh_CN/gamedata/story/"): line.split()[2]
            for line in args.story_tree.read_text().splitlines()}
    candidates, aliases = {}, defaultdict(list)
    for person in catalog["characters"]:
        portraits = [p for p in person["portraits"] if not p.get("generic") and p.get("imageUrl")]
        if not portraits or person["entityKind"] != "character":
            continue
        pid = person.get("existingGraphPersonId") or person["id"]
        candidates[pid] = {"id": pid, "name": person["name"], "aliases": person["aliases"],
            "portraits": portraits, "sources": person["sources"],
            "identity_key": person["identityKey"], "existing_matches": person.get("existingCharacterMatches", []),
            "collision_candidates": person.get("nameCollisionCandidates", []),
            "description": "\n".join(x["text"] for x in person.get("descriptions", []))[:900]}
        for name in {person["name"], *person["aliases"]}:
            if name not in ("？？？", "???", "神明", "老人", "少女", "青年", "士兵"):
                aliases[name].append(pid)
    units, script_inventory = [], {}
    for unit in metadata["story_units"]:
        found, missing = defaultdict(list), []
        for story in unit["stories"]:
            file = args.stories / story["path"]
            if not file.exists():
                missing.append(story["path"])
                continue
            content = file.read_bytes()
            blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
            if tree.get(story["path"]) != blob:
                missing.append(story["path"])
                continue
            sha = hashlib.sha256(content).hexdigest()
            script_inventory[story["path"]] = {"blob_sha1": blob, "sha256": sha}
            lines = content.decode("utf-8-sig").splitlines()
            for number, line in enumerate(lines, 1):
                match = re.match(r'\s*\[name\s*=\s*"([^"\]]+)"\s*\](.*)', line, re.IGNORECASE)
                if not match or len(match[2].strip()) < 6:
                    continue
                ids = aliases.get(match[1], [])
                if len(ids) != 1:
                    continue
                pid = ids[0]
                context = "\n".join(lines[max(0, number - 15):number + 5])
                found[pid].append({"path": story["path"], "line": number, "speaker": match[1], "quote": match[2],
                    "scene": context, "story_name": story["name"], "story_code": story["code"], "sha256": sha})
        ordered = []
        for pid, evidence in found.items():
            count = len({x["path"] for x in evidence})
            ordered.append({"person_id": pid, "name": candidates[pid]["name"], "script_count": count,
                            "dialogue_count": len(evidence), "evidence": sorted(evidence, key=lambda x: -len(x["quote"]))[:3]})
        ordered.sort(key=lambda x: (-x["script_count"], -x["dialogue_count"], x["person_id"]))
        units.append({**unit, "candidates": ordered, "missing_scripts": missing, "status": "needs_story_review"})
    output = root / ".runtime/preferences-v2/npc-candidates.json"
    output.write_text(json.dumps({"source_sha256": hashlib.sha256(raw).hexdigest(), "source": catalog["sources"],
        "persons": candidates, "units": units, "scripts": script_inventory}, ensure_ascii=False, indent=2) + "\n")
    for unit in units:
        print(unit["id"], unit["name"], " | ".join(f"{x['name']}({x['script_count']}/{x['dialogue_count']})"
              for x in unit["candidates"][:7]), "MISSING", len(unit["missing_scripts"]))


if __name__ == "__main__":
    main()
