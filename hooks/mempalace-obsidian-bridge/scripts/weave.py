#!/usr/bin/env python3
"""Offline pass: read knowledge_graph.sqlite3 → regenerate entity notes,
and (optionally) inject [[wikilinks]] for entity names into drawer notes.

Usage:
  weave.py                    # dump entity notes only
  weave.py --inject-links     # also rewrite drawer .md to add wikilinks
  weave.py --inject-links --limit 5000   # cap for a partial pass
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import VAULT, WINGS_DIR, parse_frontmatter, render_frontmatter  # noqa: E402
from _kg_common import (  # noqa: E402
    ENTITIES_DIR,
    all_entity_ids,
    inject_wikilinks,
    kg_conn,
    write_entity_note,
)


def dump_entities():
    ids = all_entity_ids()
    print(f"Entities in KG: {len(ids)}")
    if not ids:
        print("KG is empty — nothing to dump. Run /palace:weave again after the KG is populated.")
        return 0
    written = 0
    for eid in ids:
        if write_entity_note(eid):
            written += 1
    print(f"Wrote {written} entity notes → {ENTITIES_DIR}")
    return written


def collect_entity_names():
    with kg_conn() as c:
        rows = c.execute("SELECT name FROM entities").fetchall()
    return [r[0] for r in rows if r[0] and len(r[0]) >= 2]


def inject_links_pass(limit: int = 0):
    names = collect_entity_names()
    if not names:
        print("No entity names — skipping wikilink injection.")
        return 0
    print(f"Injecting [[wikilinks]] for {len(names)} entity names into drawers …")
    rewritten = 0
    scanned = 0
    for note in WINGS_DIR.rglob("*.md"):
        if note.parent.name == "_entities" or "_entities" in note.parts:
            continue
        scanned += 1
        try:
            text = note.read_text(encoding="utf-8")
        except Exception:
            continue
        fm, body = parse_frontmatter(text)
        new_body, count = inject_wikilinks(body, names)
        if count > 0 and new_body != body:
            fm["wikilinks_injected"] = "true"
            note.write_text(render_frontmatter(fm) + new_body, encoding="utf-8")
            rewritten += 1
        if scanned % 5000 == 0:
            print(f"  …scanned={scanned} rewritten={rewritten}")
        if limit and scanned >= limit:
            break
    print(f"Done. scanned={scanned} rewritten={rewritten}")
    return rewritten


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inject-links", action="store_true", help="rewrite drawers with [[wikilinks]]")
    ap.add_argument("--limit", type=int, default=0, help="cap drawers scanned (0 = all)")
    args = ap.parse_args()

    dump_entities()
    if args.inject_links:
        inject_links_pass(limit=args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
