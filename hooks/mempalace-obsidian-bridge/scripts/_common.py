"""Shared helpers for the mempalace ↔ Obsidian bridge."""
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path

VAULT = Path(os.environ.get("OBSIDIAN_VAULT_PATH", "__HOME__/Obsidian/Palace"))
WINGS_DIR = VAULT / "Wings"

# Auto-mined system rooms that bloat Obsidian and have ~zero human value.
# Drawers in these rooms stay in mempalace (source of truth) but are NOT
# mirrored into the vault. To force a mirror, edit this set or pass an
# explicit override.
NOISE_ROOMS = {"descargas", "configuration", "mangohud_logs"}


def is_noise_room(room: str) -> bool:
    return (room or "").lower() in NOISE_ROOMS


def slugify(text: str, max_len: int = 60) -> str:
    text = text.strip().splitlines()[0] if text.strip() else "untitled"
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    text = re.sub(r"[\s_-]+", "-", text)
    return (text or "untitled")[:max_len].strip("-")


def drawer_path(wing: str, room: str, drawer_id: str, content: str) -> Path:
    short = drawer_id.rsplit("_", 1)[-1][:8]
    slug = slugify(content)
    return WINGS_DIR / wing / room / f"{slug}-{short}.md"


def parse_frontmatter(text: str):
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    block = text[4:end]
    body = text[end + 5 :]
    fm = {}
    for line in block.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm, body


def render_frontmatter(fm: dict) -> str:
    out = ["---"]
    for k, v in fm.items():
        if isinstance(v, list):
            out.append(f"{k}: [{', '.join(json.dumps(x) for x in v)}]")
        elif isinstance(v, bool):
            out.append(f"{k}: {'true' if v else 'false'}")
        elif v is None or v == "":
            out.append(f"{k}: ")
        else:
            out.append(f"{k}: {v}")
    out.append("---\n")
    return "\n".join(out)


def write_drawer_md(
    wing: str,
    room: str,
    drawer_id: str,
    content: str,
    source_file: str = "",
    added_by: str = "mempalace",
    filed_at: str = None,
):
    """Write/overwrite a .md mirror of a drawer. Idempotent."""
    path = drawer_path(wing, room, drawer_id, content)
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = {
        "palace_drawer_id": drawer_id,
        "wing": wing,
        "room": room,
        "source_file": source_file or "",
        "added_by": added_by,
        "filed_at": filed_at or datetime.now().isoformat(),
        "mempalace_synced": "true",
    }
    body = content.rstrip() + "\n"
    path.write_text(render_frontmatter(fm) + body, encoding="utf-8")
    return path


def get_collection():
    """Open the live mempalace Chroma collection."""
    import chromadb
    palace = Path.home() / ".mempalace"
    config = json.loads((palace / "config.json").read_text())
    client = chromadb.PersistentClient(path=config["palace_path"])
    return client.get_collection(config["collection_name"])


def add_drawer_to_palace(wing: str, room: str, content: str, source_file: str = ""):
    """Insert a vault note as a drawer. Idempotent on (wing, room, content)."""
    col = get_collection()
    drawer_id = f"drawer_{wing}_{room}_{hashlib.md5(content.encode()).hexdigest()[:16]}"
    existing = col.get(ids=[drawer_id])
    if existing and existing["ids"]:
        return drawer_id, "already_exists"
    col.upsert(
        ids=[drawer_id],
        documents=[content],
        metadatas=[
            {
                "wing": wing,
                "room": room,
                "source_file": source_file or "",
                "chunk_index": 0,
                "added_by": "obsidian-bridge",
                "filed_at": datetime.now().isoformat(),
            }
        ],
    )
    return drawer_id, "added"
