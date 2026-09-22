# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.65.0", "brotli==1.2.0"]
# ///
"""Rename the reviewed OFL webfont subsets without changing their rendering tables."""

import argparse
import hashlib
import io
import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
FONTS = (
    ("SourceHanSansSC-Regular.woff2", "62bd772440fde355edd6d1332fafd47e35416113c37f22d0cb7094314c426efd",
     "Relationship Atlas CJK", "Regular", "SourceHanSans-OFL.txt"),
    ("SourceHanSansSC-Bold.5255c6b6.woff2", "fae04afb0412a9527ecbec47df9fbca94d778016fd9f5c5dd6954829a4de4bfa",
     "Relationship Atlas CJK", "Bold", "SourceHanSans-OFL.txt"),
    ("Oswald-Medium.99836e81.woff2", "d84e9f97be7cb696b244b2750e971bb36a74dec73f4e74c74a2a62213c7c724e",
     "Relationship Atlas Narrow", "Medium", "Oswald-OFL.txt"),
)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def prepare(source, output):
    if output.exists():
        raise ValueError("Output already exists; refusing to overwrite")
    results = []
    prepared = []
    for filename, expected, family, style, license_name in FONTS:
        path = source / filename
        if path.is_symlink():
            raise ValueError(f"Source symlink is not allowed: {filename}")
        content = path.read_bytes()
        if digest(content) != expected:
            raise ValueError(f"Unreviewed source font: {filename}")
        font = TTFont(io.BytesIO(content), recalcTimestamp=False)
        # 只接受已审查的 TrueType 子集；不把此流程套到商业字体或未知 CFF 字体。
        if font.flavor != "woff2" or "glyf" not in font or "CFF " in font:
            raise ValueError(f"Unsupported source format: {filename}")
        # SFNTReader 不是 dict，须通过 keys() 取得表名。
        table_tags = font.reader.keys()
        tables = {tag: font.getTableData(tag) for tag in table_tags}
        postscript = family.replace(" ", "") + "-" + style
        full_name = family + " " + style
        replacements = {
            1: family, 2: style, 3: f"{postscript};atlas-ofl-1;{expected[:12]}",
            4: full_name, 6: postscript, 16: family, 17: style, 18: full_name,
            21: family, 22: style, 25: family.replace(" ", ""),
        }
        for record in font["name"].names:
            if record.nameID in replacements:
                record.string = replacements[record.nameID].encode(record.getEncoding())
        license_content = (ROOT / "assets/licenses" / license_name).read_text()
        for name_id, text in {**replacements, 13: license_content, 14: "https://openfontlicense.org/"}.items():
            font["name"].setName(text, name_id, 3, 1, 0x409)
        buffer = io.BytesIO()
        font.save(buffer)
        encoded = buffer.getvalue()
        check = TTFont(io.BytesIO(encoded), recalcTimestamp=False)
        if set(check.reader.keys()) != set(tables):
            raise ValueError(f"Font table set changed: {filename}")
        for tag, original in tables.items():
            if tag == "name":
                continue
            actual = check.getTableData(tag)
            if tag == "head":
                # name 修改会改变整字体校验和；其余 head 字段仍必须完全相同。
                original = original[:8] + b"\0" * 4 + original[12:]
                actual = actual[:8] + b"\0" * 4 + actual[12:]
            if actual != original:
                raise ValueError(f"Unexpected table change: {filename}/{tag}")
        target = f"{postscript}.{digest(encoded)[:12]}.woff2"
        prepared.append((target, encoded))
        results.append({"source_file": filename, "source_sha256": expected, "file": target,
                        "sha256": digest(encoded), "bytes": len(encoded), "family": family,
                        "style": style, "license_file": license_name,
                        "codepoints": len(check.getBestCmap()), "rendering_tables_unchanged": True})
    output.mkdir(parents=True)
    for name, content in prepared:
        (output / name).write_bytes(content)
    (output / "font-review.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Reviewed original subset directory")
    parser.add_argument("--output", type=Path, required=True, help="New output directory")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.output), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"OFL font preparation error: {exc}\n")


if __name__ == "__main__":
    main()
