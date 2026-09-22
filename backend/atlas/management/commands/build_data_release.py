import hashlib
import subprocess
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.release_assets import validate_release_assets
from atlas.releasing import build_package
from atlas.source_data import compile_source, json_bytes


def source_matches_commit(source, root, commit):
    relative = source.relative_to(Path(root)).as_posix()
    tree = subprocess.check_output(["git", "ls-tree", "-r", "-z", commit, "--", relative], cwd=root)
    tracked = {}
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        header, path = entry.split(b"\t", 1)
        mode, kind, oid = header.split()
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            return False
        tracked[path.decode()] = oid.decode()
    actual = {}
    for path in source.rglob("*"):
        if path.is_file():
            value = path.read_bytes()
            actual[path.relative_to(root).as_posix()] = hashlib.sha1(
                b"blob " + str(len(value)).encode() + b"\0" + value
            ).hexdigest()
    return bool(actual) and actual == tracked


class Command(BaseCommand):
    help = "Build a versioned package from Git source; uncommitted input is permitted only for local rehearsal."

    def add_arguments(self, parser):
        parser.add_argument("--source", type=Path, default=Path("data/source"))
        parser.add_argument("--release-id", required=True)
        parser.add_argument("--expected-previous")
        parser.add_argument("--asset-version", required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--allow-dirty", action="store_true")

    def handle(self, *args, **options):
        if options["output"].exists():
            raise CommandError("Release output already exists; refusing to overwrite.")
        source = options["source"].resolve()
        try:
            root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=source, text=True).strip()
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root))
            dirty = dirty or not source_matches_commit(source, root, commit)
            if dirty and not options["allow_dirty"]:
                raise CommandError("Commit and review the source first, or use --allow-dirty for local rehearsal.")
            package = build_package(compile_source(source), release_id=options["release_id"], git_commit=commit,
                                    expected_previous=options["expected_previous"], asset_version=options["asset_version"],
                                    dirty=dirty, source_path=source.relative_to(root).as_posix())
            validate_release_assets(package)
        except (ValidationError, subprocess.CalledProcessError, OSError) as exc:
            raise CommandError(str(exc)) from exc
        output = options["output"]
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as file:
            output.chmod(0o600)
            file.write(json_bytes(package))
        self.stdout.write(f"Built {package['manifest']['release_id']} (working_tree_dirty={dirty}).")
