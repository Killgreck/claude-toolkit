"""Shared helpers for the KG ↔ Obsidian bridge."""
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from _common import VAULT, WINGS_DIR, parse_frontmatter, render_frontmatter, slugify

KG_DB = Path.home() / ".mempalace" / "knowledge_graph.sqlite3"
ENTITIES_DIR = WINGS_DIR / "_entities"


def kg_conn():
    return sqlite3.connect(KG_DB)


def entity_note_path(entity_id: str, name: str) -> Path:
    slug = slugify(name) or entity_id
    return ENTITIES_DIR / f"{slug}-{entity_id}.md"


def render_entity_note(entity: dict, triples_out: list, triples_in: list) -> str:
    """entity = {id, name, type, properties (json), created_at}.
    triples_*: rows from triples table."""
    fm = {
        "palace_entity_id": entity["id"],
        "entity_name": entity["name"],
        "entity_type": entity.get("type") or "unknown",
        "created_at": entity.get("created_at") or "",
        "mempalace_synced": "true",
        "kind": "entity",
    }
    parts = [render_frontmatter(fm), f"# {entity['name']}\n"]

    props = {}
    try:
        props = json.loads(entity.get("properties") or "{}")
    except Exception:
        props = {}
    if props:
        parts.append("## Properties\n")
        for k, v in props.items():
            if v not in ("", None):
                parts.append(f"- **{k}**: {v}")
        parts.append("")

    if triples_out:
        parts.append("## Outgoing relations\n")
        for t in triples_out:
            line = _fmt_triple(t, direction="out")
            parts.append(f"- {line}")
        parts.append("")

    if triples_in:
        parts.append("## Incoming relations\n")
        for t in triples_in:
            line = _fmt_triple(t, direction="in")
            parts.append(f"- {line}")
        parts.append("")

    return "\n".join(parts) + "\n"


def _fmt_triple(t: dict, direction: str) -> str:
    """t row keys: subject, predicate, object, valid_from, valid_to, confidence, source_file."""
    pred = (t.get("predicate") or "").replace("_", " ")
    other = t["object"] if direction == "out" else t["subject"]
    name = _entity_display_name(other)
    valid_from = t.get("valid_from") or ""
    valid_to = t.get("valid_to") or ""
    span = ""
    if valid_from or valid_to:
        span = f" *({valid_from or '?'} → {valid_to or 'present'})*"
    src = ""
    if t.get("source_file"):
        src = f"  — source: `{t['source_file']}`"
    arrow = "→" if direction == "out" else "←"
    return f"{arrow} **{pred}** [[{name}]]{span}{src}"


def _entity_display_name(entity_id: str) -> str:
    """Look up the entity's pretty name from the KG. Falls back to the id."""
    try:
        with kg_conn() as c:
            row = c.execute("SELECT name FROM entities WHERE id=?", (entity_id,)).fetchone()
            return row[0] if row else entity_id
    except Exception:
        return entity_id


def write_entity_note(entity_id: str):
    """Refresh the .md note for one entity. Returns the Path written or None if entity missing."""
    with kg_conn() as c:
        c.row_factory = sqlite3.Row
        ent_row = c.execute("SELECT * FROM entities WHERE id=?", (entity_id,)).fetchone()
        if not ent_row:
            return None
        out = [
            dict(r)
            for r in c.execute(
                "SELECT * FROM triples WHERE subject=? ORDER BY valid_from", (entity_id,)
            )
        ]
        inc = [
            dict(r)
            for r in c.execute(
                "SELECT * FROM triples WHERE object=? ORDER BY valid_from", (entity_id,)
            )
        ]
    entity = dict(ent_row)
    ENTITIES_DIR.mkdir(parents=True, exist_ok=True)
    path = entity_note_path(entity["id"], entity["name"])
    path.write_text(render_entity_note(entity, out, inc), encoding="utf-8")
    return path


def all_entity_ids():
    with kg_conn() as c:
        return [r[0] for r in c.execute("SELECT id FROM entities")]


def entity_id_from_name(name: str) -> str:
    return name.lower().replace(" ", "_").replace("'", "")


def inject_wikilinks(text: str, entity_names: list) -> tuple[str, int]:
    """Replace first occurrence of each entity name in text with [[name]].
    Skips occurrences inside existing wikilinks or code fences. Returns (new_text, count)."""
    if not entity_names:
        return text, 0

    # Build a single pattern, longest first to handle multi-word names correctly.
    sorted_names = sorted({n for n in entity_names if n}, key=len, reverse=True)
    if not sorted_names:
        return text, 0
    pattern = re.compile(
        r"(?<!\[\[)(?<!\w)(" + "|".join(re.escape(n) for n in sorted_names) + r")(?!\w)(?!\]\])",
        flags=re.IGNORECASE,
    )

    inserted = {n.lower(): False for n in sorted_names}

    def repl(m):
        word = m.group(1)
        key = word.lower()
        if inserted.get(key):
            return word
        inserted[key] = True
        return f"[[{word}]]"

    new_text = pattern.sub(repl, text)
    count = sum(1 for v in inserted.values() if v)
    return new_text, count
