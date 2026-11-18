#!/usr/bin/env python3
"""Offline KG bootstrap: scan drawers in chroma, find recurring proper nouns,
classify them as person/project via mempalace's entity_detector, and upsert
into the knowledge graph.

By default skips NOISE_ROOMS (descargas/configuration/mangohud_logs) — those
are auto-mined system files where false positives dominate. Override with
--include-rooms a,b,c or --all-rooms.

No triples are extracted — relationship extraction needs an LLM.
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, "__HOME__/mempalace/mempalace")

from _common import NOISE_ROOMS, get_collection  # noqa: E402
from entity_detector import (  # noqa: E402
    classify_entity,
    extract_candidates,
    score_entity,
)
from knowledge_graph import KnowledgeGraph  # noqa: E402

BATCH = 1000
MAX_CONTEXT_BYTES_FOR_SCORING = 200_000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-freq", type=int, default=3, help="global frequency threshold")
    ap.add_argument(
        "--include-rooms",
        default=None,
        help="comma-separated room names to include (default: all except NOISE_ROOMS)",
    )
    ap.add_argument(
        "--all-rooms", action="store_true", help="don't skip NOISE_ROOMS (descargas/configuration/mangohud_logs)"
    )
    args = ap.parse_args()

    include = set(r.strip() for r in args.include_rooms.split(",")) if args.include_rooms else None
    skip_noise = not args.all_rooms

    col = get_collection()
    total = col.count()
    print(f"Scanning {total} drawers (skip_noise={skip_noise}, include={include})")

    global_counter: Counter = Counter()
    contexts: dict[str, list[str]] = {}

    offset = 0
    seen = 0
    while offset < total:
        page = col.get(limit=BATCH, offset=offset, include=["documents", "metadatas"])
        ids = page.get("ids") or []
        docs = page.get("documents") or []
        metas = page.get("metadatas") or []
        if not ids:
            break
        for content, meta in zip(docs, metas):
            if not content:
                continue
            room = (meta or {}).get("room", "")
            if include is not None and room not in include:
                continue
            if skip_noise and room in NOISE_ROOMS:
                continue
            seen += 1
            cands = extract_candidates(content)
            for name, freq in cands.items():
                global_counter[name] += freq
                bucket = contexts.setdefault(name, [])
                if len(bucket) < 5 and len(content) < 50_000:
                    bucket.append(content)
        offset += len(ids)
        if offset % 10_000 == 0:
            print(f"  …{offset}/{total}  used={seen}  unique_candidates={len(global_counter)}")
    print(f"  scanned={offset} used={seen}")

    promoted = [(n, f) for n, f in global_counter.items() if f >= args.min_freq]
    print(f"\nGlobal candidates: {len(global_counter)}; promoted (freq≥{args.min_freq}): {len(promoted)}")

    kg = KnowledgeGraph()
    n_person = n_project = n_uncertain = 0
    for name, freq in sorted(promoted, key=lambda x: -x[1]):
        snippets = contexts.get(name, [])
        joined = "\n".join(snippets)[:MAX_CONTEXT_BYTES_FOR_SCORING]
        try:
            scores = score_entity(name, joined, joined.splitlines())
            entity = classify_entity(name, freq, scores)
        except Exception:
            entity = {"type": "uncertain", "confidence": 0.0}

        etype = entity["type"]
        kg.add_entity(
            name,
            etype if etype != "uncertain" else "unknown",
            {
                "frequency": freq,
                "confidence": float(entity.get("confidence", 0)),
                "bootstrap_source": "extract_kg_from_drawers",
            },
        )
        if etype == "person":
            n_person += 1
        elif etype == "project":
            n_project += 1
        else:
            n_uncertain += 1

    print(f"\nKG seeded:")
    print(f"  people    = {n_person}")
    print(f"  projects  = {n_project}")
    print(f"  uncertain = {n_uncertain}")
    print(f"  total     = {n_person + n_project + n_uncertain}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
