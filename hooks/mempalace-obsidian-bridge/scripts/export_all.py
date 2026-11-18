#!/usr/bin/env python3
"""One-time bulk export: every existing mempalace drawer → .md mirror.

Read-only on the palace. Skips drawers whose .md already exists with the
same drawer_id frontmatter. Safe to re-run.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    VAULT,
    WINGS_DIR,
    drawer_path,
    get_collection,
    is_noise_room,
    write_drawer_md,
)

BATCH = 500


def main():
    col = get_collection()
    total = col.count()
    print(f"Exporting {total} drawers from mempalace → {VAULT}")
    WINGS_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    offset = 0
    while offset < total:
        page = col.get(limit=BATCH, offset=offset, include=["metadatas", "documents"])
        ids = page.get("ids") or []
        docs = page.get("documents") or []
        metas = page.get("metadatas") or []
        if not ids:
            break
        for did, content, meta in zip(ids, docs, metas):
            wing = (meta or {}).get("wing") or "unknown"
            room = (meta or {}).get("room") or "unknown"
            if not content:
                skipped += 1
                continue
            if is_noise_room(room):
                skipped += 1
                continue
            target = drawer_path(wing, room, did, content)
            if target.exists():
                skipped += 1
                continue
            try:
                write_drawer_md(
                    wing=wing,
                    room=room,
                    drawer_id=did,
                    content=content,
                    source_file=(meta or {}).get("source_file", ""),
                    added_by=(meta or {}).get("added_by", "mempalace"),
                    filed_at=(meta or {}).get("filed_at"),
                )
                written += 1
            except Exception as e:
                sys.stderr.write(f"[export] {did}: {e}\n")
                skipped += 1
        offset += len(ids)
        print(f"  …{offset}/{total}  written={written} skipped={skipped}")

    print(f"Done. wrote={written} skipped={skipped} total={total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
