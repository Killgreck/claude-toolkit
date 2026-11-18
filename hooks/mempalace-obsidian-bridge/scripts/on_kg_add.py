#!/usr/bin/env python3
"""PostToolUse hook for mcp__mempalace__mempalace_kg_add.

Refreshes the entity notes for the subject and the object of the new triple
(plus its referenced entities) so the vault graph mirrors the KG live.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _kg_common import entity_id_from_name, write_entity_note  # noqa: E402


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0

    if payload.get("tool_name") != "mcp__mempalace__mempalace_kg_add":
        return 0

    inp = payload.get("tool_input", {}) or {}
    resp = payload.get("tool_response", {}) or {}
    if isinstance(resp, dict) and resp.get("error"):
        return 0

    # tool_kg_add signature: subject, predicate, object, valid_from?, valid_to?, ...
    subject = inp.get("subject")
    obj = inp.get("object")
    touched = []
    for name in (subject, obj):
        if not name:
            continue
        eid = entity_id_from_name(name)
        try:
            p = write_entity_note(eid)
            if p:
                touched.append(p.name)
        except Exception as e:
            sys.stderr.write(f"[bridge-kg] {eid}: {e}\n")

    if touched:
        sys.stderr.write(f"[bridge-kg] refreshed: {', '.join(touched)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
