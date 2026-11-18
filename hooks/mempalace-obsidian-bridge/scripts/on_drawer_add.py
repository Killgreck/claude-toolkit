#!/usr/bin/env python3
"""PostToolUse hook: mirror a freshly added mempalace drawer as a .md note.

Receives Claude Code's PostToolUse JSON payload on stdin. Exits 0 silently
unless something explodes — we never want to block tool flow.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import is_noise_room, write_drawer_md  # noqa: E402


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0

    if payload.get("tool_name") != "mcp__mempalace__mempalace_add_drawer":
        return 0

    inp = payload.get("tool_input", {}) or {}
    resp = payload.get("tool_response", {}) or {}

    # Tool response shape: {"success": True, "drawer_id": "...", "wing": "...", "room": "..."}
    if not (resp.get("success") and resp.get("drawer_id")):
        return 0

    wing = resp.get("wing") or inp.get("wing")
    room = resp.get("room") or inp.get("room")
    content = inp.get("content") or ""
    if not (wing and room and content):
        return 0
    if is_noise_room(room):
        return 0

    try:
        path = write_drawer_md(
            wing=wing,
            room=room,
            drawer_id=resp["drawer_id"],
            content=content,
            source_file=inp.get("source_file", ""),
            added_by=inp.get("added_by", "mcp"),
        )
        sys.stderr.write(f"[bridge] mirrored → {path}\n")
    except Exception as e:
        sys.stderr.write(f"[bridge] mirror failed: {e}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
