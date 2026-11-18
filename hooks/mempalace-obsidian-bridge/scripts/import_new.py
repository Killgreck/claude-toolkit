#!/usr/bin/env python3
"""Scan the Obsidian vault for notes WITHOUT mempalace_synced=true and
ingest them into mempalace as drawers.

Convention:
  Wings/<wing>/<room>/<note>.md  → wing/room inferred from path.
  Notes in the vault root or outside Wings/ are routed to wing=apolo,
  room=obsidian_inbox unless frontmatter overrides.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import VAULT, WINGS_DIR, add_drawer_to_palace, parse_frontmatter, render_frontmatter  # noqa: E402

DEFAULT_WING = "apolo"
DEFAULT_ROOM = "obsidian_inbox"


def infer_wing_room(path: Path) -> tuple[str, str]:
    try:
        rel = path.relative_to(WINGS_DIR)
        parts = rel.parts
        if len(parts) >= 2:
            return parts[0], parts[1]
    except ValueError:
        pass
    return DEFAULT_WING, DEFAULT_ROOM


def already_synced(fm: dict) -> bool:
    v = str(fm.get("mempalace_synced", "")).strip().lower()
    return v in ("true", "1", "yes")


def main():
    if not VAULT.exists():
        print(f"Vault not found: {VAULT}", file=sys.stderr)
        return 1

    candidates = list(VAULT.rglob("*.md"))
    print(f"Scanning {len(candidates)} notes in {VAULT}")

    added = 0
    skipped = 0
    for note in candidates:
        # Skip vault metadata folder
        if ".obsidian" in note.parts:
            continue
        try:
            text = note.read_text(encoding="utf-8")
        except Exception:
            continue
        fm, body = parse_frontmatter(text)
        if already_synced(fm):
            skipped += 1
            continue
        body = body.strip()
        if len(body) < 20:
            skipped += 1
            continue
        wing = fm.get("wing") or infer_wing_room(note)[0]
        room = fm.get("room") or infer_wing_room(note)[1]

        try:
            drawer_id, status = add_drawer_to_palace(
                wing=wing, room=room, content=body, source_file=str(note)
            )
        except Exception as e:
            sys.stderr.write(f"[import] {note}: {e}\n")
            continue

        # Stamp the note so the loop guard kicks in next time.
        fm.update(
            {
                "palace_drawer_id": drawer_id,
                "wing": wing,
                "room": room,
                "mempalace_synced": "true",
            }
        )
        note.write_text(render_frontmatter(fm) + body.rstrip() + "\n", encoding="utf-8")
        added += 1
        print(f"  + {wing}/{room} ← {note.name} ({status})")

    print(f"Done. added={added} skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
