#!/usr/bin/env python3
"""Palace Curator — local web UI for browsing/curating mempalace.

Browse KG entities and drawers, inspect mentions, multi-select + delete.
Bound to 127.0.0.1 only.

Run:
    python3 palace_app.py [--port 7777]
"""
import argparse
import html
import json
import sqlite3
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import VAULT, get_collection  # noqa: E402
from _kg_common import KG_DB, entity_id_from_name, entity_note_path  # noqa: E402

ENTITY_NOTES_DIR = VAULT / "Wings" / "_entities"


# ============================================================
# Data layer
# ============================================================


def kg():
    c = sqlite3.connect(KG_DB)
    c.row_factory = sqlite3.Row
    return c


def list_entities(q: str = "", typ: str = ""):
    with kg() as c:
        rows = c.execute("SELECT id, name, type, properties, created_at FROM entities").fetchall()
    out = []
    for r in rows:
        try:
            props = json.loads(r["properties"] or "{}")
        except Exception:
            props = {}
        item = {
            "id": r["id"],
            "name": r["name"],
            "type": r["type"] or "unknown",
            "frequency": props.get("frequency", 0),
            "confidence": props.get("confidence", 0),
            "properties": props,
            "created_at": r["created_at"],
        }
        if q and q.lower() not in r["name"].lower():
            continue
        if typ and item["type"] != typ:
            continue
        out.append(item)
    out.sort(key=lambda e: -e["frequency"])
    return out


def entity_mentions(name: str, limit: int = 25):
    """Count and return drawers whose document contains the entity name."""
    col = get_collection()
    if not col:
        return {"count": 0, "samples": []}
    res = col.get(
        where_document={"$contains": name},
        include=["documents", "metadatas"],
        limit=limit,
    )
    samples = []
    for did, doc, meta in zip(res.get("ids", []), res.get("documents", []), res.get("metadatas", [])):
        snippet = (doc or "")[:400].replace("\n", " ")
        samples.append(
            {
                "id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "source_file": (meta or {}).get("source_file", ""),
                "snippet": snippet,
            }
        )
    # Approximate total via a second cheap call without limit (Chroma counts all matches).
    try:
        all_ids = col.get(where_document={"$contains": name}, include=[]).get("ids", [])
        total = len(all_ids)
    except Exception:
        total = len(samples)
    return {"count": total, "samples": samples}


def delete_entities(ids: list[str], also_drawers: bool = False):
    deleted_entities = 0
    deleted_triples = 0
    deleted_drawers = 0
    deleted_notes = 0
    with kg() as c:
        for eid in ids:
            row = c.execute("SELECT name FROM entities WHERE id=?", (eid,)).fetchone()
            if not row:
                continue
            name = row["name"]
            t = c.execute(
                "DELETE FROM triples WHERE subject=? OR object=?", (eid, eid)
            ).rowcount
            deleted_triples += t or 0
            e = c.execute("DELETE FROM entities WHERE id=?", (eid,)).rowcount
            deleted_entities += e or 0
            note = entity_note_path(eid, name)
            if note.exists():
                note.unlink()
                deleted_notes += 1
            if also_drawers:
                deleted_drawers += _delete_drawers_mentioning(name)
        c.commit()
    return {
        "entities_deleted": deleted_entities,
        "triples_deleted": deleted_triples,
        "entity_notes_deleted": deleted_notes,
        "drawers_deleted": deleted_drawers,
    }


def _delete_drawers_mentioning(name: str) -> int:
    col = get_collection()
    if not col:
        return 0
    ids = col.get(where_document={"$contains": name}, include=[]).get("ids", [])
    if ids:
        col.delete(ids=ids)
    return len(ids)


def list_drawers(wing: str = "", room: str = "", q: str = "", limit: int = 50, offset: int = 0):
    col = get_collection()
    if not col:
        return {"total": 0, "items": []}
    where = {}
    parts = []
    if wing:
        parts.append({"wing": wing})
    if room:
        parts.append({"room": room})
    if len(parts) == 1:
        where = parts[0]
    elif len(parts) > 1:
        where = {"$and": parts}
    where_doc = {"$contains": q} if q else None
    kwargs = {"include": ["documents", "metadatas"], "limit": limit, "offset": offset}
    if where:
        kwargs["where"] = where
    if where_doc:
        kwargs["where_document"] = where_doc
    res = col.get(**kwargs)
    items = []
    for did, doc, meta in zip(res.get("ids", []), res.get("documents", []), res.get("metadatas", [])):
        items.append(
            {
                "id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "source_file": (meta or {}).get("source_file", ""),
                "snippet": (doc or "")[:300].replace("\n", " "),
            }
        )
    # total count
    count_kwargs = {"include": []}
    if where:
        count_kwargs["where"] = where
    if where_doc:
        count_kwargs["where_document"] = where_doc
    try:
        total = len(col.get(**count_kwargs).get("ids", []))
    except Exception:
        total = len(items)
    return {"total": total, "items": items}


def get_drawer(drawer_id: str):
    col = get_collection()
    if not col:
        return None
    res = col.get(ids=[drawer_id], include=["documents", "metadatas"])
    if not res.get("ids"):
        return None
    return {
        "id": drawer_id,
        "metadata": (res.get("metadatas") or [{}])[0],
        "content": (res.get("documents") or [""])[0],
    }


def delete_drawers(ids: list[str]) -> int:
    col = get_collection()
    if not col or not ids:
        return 0
    col.delete(ids=ids)
    return len(ids)


def stats():
    col = get_collection()
    drawer_total = col.count() if col else 0
    with kg() as c:
        n_ent = c.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        n_tri = c.execute("SELECT COUNT(*) FROM triples").fetchone()[0]
        types = dict(c.execute("SELECT type, COUNT(*) FROM entities GROUP BY type").fetchall())
    return {
        "drawers": drawer_total,
        "entities": n_ent,
        "triples": n_tri,
        "entity_types": types,
        "vault": str(VAULT),
    }


# ============================================================
# HTTP layer
# ============================================================


HTML_PAGE = r"""<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Palace Curator</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background:#0e1116; color:#e6e6e6; }
  header { padding: 12px 18px; background:#161b22; border-bottom:1px solid #30363d; display:flex; gap:18px; align-items:center; }
  header h1 { margin:0; font-size:16px; font-weight:600; color:#f0c674; }
  header .stats { font-size:12px; color:#8b949e; }
  nav { padding: 8px 18px; background:#161b22; border-bottom:1px solid #30363d; display:flex; gap:6px; }
  nav button { background:#21262d; color:#e6e6e6; border:1px solid #30363d; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
  nav button.active { background:#1f6feb; border-color:#1f6feb; }
  main { padding: 14px 18px; }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
  input, select { background:#0d1117; color:#e6e6e6; border:1px solid #30363d; padding:6px 10px; border-radius:6px; font-size:13px; }
  button.action { background:#da3633; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
  button.action.cool { background:#238636; }
  button.action.neutral { background:#1f6feb; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:6px 8px; text-align:left; border-bottom:1px solid #21262d; }
  th { background:#161b22; position:sticky; top:0; cursor:pointer; user-select:none; color:#8b949e; font-weight:500; }
  tr:hover td { background:#161b22; }
  td.snippet { color:#8b949e; font-family: ui-monospace, monospace; font-size:11px; max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { display:inline-block; padding:1px 6px; font-size:10px; border-radius:10px; background:#30363d; }
  .badge.person { background:#d29922; color:#000; }
  .badge.project { background:#2ea043; color:#000; }
  .badge.unknown { background:#484f58; }
  #panel { position:fixed; right:0; top:0; bottom:0; width:560px; background:#161b22; border-left:1px solid #30363d; padding:16px; overflow-y:auto; box-shadow:-4px 0 12px rgba(0,0,0,0.5); transform:translateX(100%); transition:transform 0.18s ease; z-index:50; }
  #panel.open { transform:translateX(0); }
  #panel h2 { margin-top:0; font-size:15px; }
  #panel .close { float:right; cursor:pointer; color:#8b949e; }
  .mention { padding:8px; border:1px solid #30363d; border-radius:6px; margin-bottom:8px; font-size:12px; }
  .mention .meta { color:#8b949e; font-size:10px; margin-bottom:4px; }
  .mention .body { color:#e6e6e6; font-family: ui-monospace, monospace; }
  .footer-fixed { position:sticky; bottom:0; background:#0e1116; padding:10px 0; border-top:1px solid #21262d; display:flex; gap:8px; align-items:center; }
  .pill { font-size:11px; padding:2px 6px; border-radius:8px; background:#30363d; color:#e6e6e6; }
  .danger { color:#f85149; }
</style>
</head><body>

<header>
  <h1>Palace Curator</h1>
  <span id="stats" class="stats">…</span>
  <span style="flex:1"></span>
  <span class="pill" id="vaultpath"></span>
</header>

<nav>
  <button id="tab-entities" class="active" onclick="showTab('entities')">Entidades</button>
  <button id="tab-drawers" onclick="showTab('drawers')">Drawers</button>
</nav>

<main>

<section id="view-entities">
  <div class="toolbar">
    <input id="ent-q" placeholder="buscar nombre…" oninput="loadEntities()">
    <select id="ent-type" onchange="loadEntities()">
      <option value="">— todos los tipos —</option>
      <option value="person">person</option>
      <option value="project">project</option>
      <option value="unknown">unknown</option>
    </select>
    <span class="pill" id="ent-count"></span>
    <span style="flex:1"></span>
    <button class="action neutral" onclick="selectAllEntities(true)">Seleccionar todos los visibles</button>
    <button class="action neutral" onclick="selectAllEntities(false)">Limpiar selección</button>
    <label style="font-size:12px"><input id="also-drawers" type="checkbox"> también borrar drawers que mencionan</label>
    <button class="action" onclick="deleteSelectedEntities()">Borrar seleccionadas</button>
  </div>
  <div style="max-height:calc(100vh - 220px); overflow-y:auto;">
    <table id="ent-table">
      <thead><tr>
        <th><input type="checkbox" id="ent-all" onchange="toggleAllEntities(this.checked)"></th>
        <th onclick="sortEntities('frequency')">freq</th>
        <th onclick="sortEntities('type')">type</th>
        <th onclick="sortEntities('name')">name</th>
        <th>id</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</section>

<section id="view-drawers" style="display:none">
  <div class="toolbar">
    <input id="drw-q" placeholder="buscar contenido…" oninput="loadDrawers()">
    <input id="drw-wing" placeholder="wing" oninput="loadDrawers()">
    <input id="drw-room" placeholder="room" oninput="loadDrawers()">
    <span class="pill" id="drw-count"></span>
    <span style="flex:1"></span>
    <button class="action" onclick="deleteSelectedDrawers()">Borrar seleccionados</button>
  </div>
  <div style="max-height:calc(100vh - 220px); overflow-y:auto;">
    <table id="drw-table">
      <thead><tr>
        <th><input type="checkbox" id="drw-all" onchange="toggleAllDrawers(this.checked)"></th>
        <th>wing</th>
        <th>room</th>
        <th>source</th>
        <th>snippet</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</section>

</main>

<aside id="panel">
  <span class="close" onclick="closePanel()">✕ cerrar</span>
  <h2 id="panel-title">…</h2>
  <div id="panel-body"></div>
</aside>

<script>
let entities = [];
let entSort = "frequency";
let entSortDir = -1;
let drawers = [];

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function loadStats() {
  const s = await api("/api/stats");
  document.getElementById("stats").textContent =
    `${s.drawers.toLocaleString()} drawers · ${s.entities} entidades · ${s.triples} triples`;
  document.getElementById("vaultpath").textContent = s.vault;
}

async function loadEntities() {
  const q = document.getElementById("ent-q").value;
  const t = document.getElementById("ent-type").value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (t) params.set("type", t);
  entities = await api("/api/entities?" + params);
  renderEntities();
}

function renderEntities() {
  const tbody = document.querySelector("#ent-table tbody");
  entities.sort((a,b) => {
    let av = a[entSort], bv = b[entSort];
    if (typeof av === "string") return entSortDir * av.localeCompare(bv);
    return entSortDir * ((av||0) - (bv||0));
  });
  tbody.innerHTML = entities.map(e => `
    <tr>
      <td><input type="checkbox" class="ent-cb" data-id="${e.id}"></td>
      <td>${e.frequency}</td>
      <td><span class="badge ${e.type}">${e.type}</span></td>
      <td><a href="#" onclick="inspectEntity('${e.id}', '${escAttr(e.name)}'); return false">${escHtml(e.name)}</a></td>
      <td style="color:#6e7681; font-family:ui-monospace,monospace; font-size:11px">${e.id}</td>
    </tr>
  `).join("");
  document.getElementById("ent-count").textContent = entities.length + " visibles";
}

function sortEntities(key) {
  if (entSort === key) entSortDir = -entSortDir;
  else { entSort = key; entSortDir = (key === "frequency") ? -1 : 1; }
  renderEntities();
}

function toggleAllEntities(on) {
  document.querySelectorAll(".ent-cb").forEach(cb => cb.checked = on);
}
function selectAllEntities(on) {
  document.getElementById("ent-all").checked = on;
  toggleAllEntities(on);
}

async function inspectEntity(id, name) {
  const data = await api("/api/entities/" + encodeURIComponent(id) + "/mentions");
  document.getElementById("panel-title").textContent = name + " (" + data.count + " menciones)";
  document.getElementById("panel-body").innerHTML = data.samples.map(s => `
    <div class="mention">
      <div class="meta">${s.wing}/${s.room} · <span style="color:#6e7681">${escHtml(s.source_file||"")}</span></div>
      <div class="body">${escHtml(s.snippet)}</div>
    </div>
  `).join("") || "<p>(sin menciones)</p>";
  document.getElementById("panel").classList.add("open");
}

function closePanel() {
  document.getElementById("panel").classList.remove("open");
}

async function deleteSelectedEntities() {
  const ids = [...document.querySelectorAll(".ent-cb:checked")].map(cb => cb.dataset.id);
  if (!ids.length) return alert("Nada seleccionado.");
  const alsoDrawers = document.getElementById("also-drawers").checked;
  const msg = `Borrar ${ids.length} entidades` + (alsoDrawers ? " y todos los drawers que las mencionan" : "") + "?";
  if (!confirm(msg)) return;
  const r = await api("/api/entities/delete", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ids, also_drawers: alsoDrawers}),
  });
  alert(`Borradas: ${r.entities_deleted} entidades, ${r.triples_deleted} triples, ${r.entity_notes_deleted} notas vault, ${r.drawers_deleted} drawers.`);
  await loadStats();
  await loadEntities();
}

async function loadDrawers() {
  const params = new URLSearchParams();
  const q = document.getElementById("drw-q").value;
  const w = document.getElementById("drw-wing").value;
  const r = document.getElementById("drw-room").value;
  if (q) params.set("q", q);
  if (w) params.set("wing", w);
  if (r) params.set("room", r);
  params.set("limit", 200);
  const data = await api("/api/drawers?" + params);
  drawers = data.items;
  document.getElementById("drw-count").textContent = data.total + " match (mostrando " + drawers.length + ")";
  const tbody = document.querySelector("#drw-table tbody");
  tbody.innerHTML = drawers.map(d => `
    <tr>
      <td><input type="checkbox" class="drw-cb" data-id="${d.id}"></td>
      <td>${escHtml(d.wing)}</td>
      <td>${escHtml(d.room)}</td>
      <td style="font-family:ui-monospace,monospace; font-size:11px; color:#6e7681">${escHtml(d.source_file).slice(0,80)}</td>
      <td class="snippet"><a href="#" onclick="inspectDrawer('${d.id}'); return false">${escHtml(d.snippet)}</a></td>
    </tr>
  `).join("");
}

function toggleAllDrawers(on) {
  document.querySelectorAll(".drw-cb").forEach(cb => cb.checked = on);
}

async function inspectDrawer(id) {
  const data = await api("/api/drawer/" + encodeURIComponent(id));
  document.getElementById("panel-title").textContent = id;
  document.getElementById("panel-body").innerHTML = `
    <div class="meta" style="color:#8b949e; margin-bottom:8px">${escHtml(JSON.stringify(data.metadata, null, 2))}</div>
    <pre style="white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:12px">${escHtml(data.content)}</pre>
  `;
  document.getElementById("panel").classList.add("open");
}

async function deleteSelectedDrawers() {
  const ids = [...document.querySelectorAll(".drw-cb:checked")].map(cb => cb.dataset.id);
  if (!ids.length) return alert("Nada seleccionado.");
  if (!confirm(`Borrar ${ids.length} drawers? (se va de chroma — irreversible salvo backup)`)) return;
  const r = await api("/api/drawers/delete", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ids}),
  });
  alert(`Borrados: ${r.drawers_deleted}`);
  await loadStats();
  await loadDrawers();
}

function showTab(name) {
  document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  document.getElementById("view-entities").style.display = (name === "entities") ? "" : "none";
  document.getElementById("view-drawers").style.display = (name === "drawers") ? "" : "none";
  if (name === "drawers" && !drawers.length) loadDrawers();
}

function escHtml(s) { return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s) { return (s||"").replace(/'/g, "\\'"); }

loadStats();
loadEntities();
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # keep stdout clean
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, body):
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = u.path
        try:
            if path == "/" or path == "/index.html":
                return self._send_html(HTML_PAGE)
            if path == "/api/stats":
                return self._send_json(stats())
            if path == "/api/entities":
                return self._send_json(
                    list_entities(q.get("q", [""])[0], q.get("type", [""])[0])
                )
            if path.startswith("/api/entities/") and path.endswith("/mentions"):
                eid = urllib.parse.unquote(path.split("/")[3])
                with kg() as c:
                    row = c.execute("SELECT name FROM entities WHERE id=?", (eid,)).fetchone()
                if not row:
                    return self._send_json({"count": 0, "samples": []})
                return self._send_json(entity_mentions(row["name"]))
            if path == "/api/drawers":
                return self._send_json(
                    list_drawers(
                        wing=q.get("wing", [""])[0],
                        room=q.get("room", [""])[0],
                        q=q.get("q", [""])[0],
                        limit=int(q.get("limit", ["50"])[0]),
                        offset=int(q.get("offset", ["0"])[0]),
                    )
                )
            if path.startswith("/api/drawer/"):
                did = urllib.parse.unquote(path[len("/api/drawer/"):])
                d = get_drawer(did)
                return self._send_json(d or {"error": "not found"}, 404 if not d else 200)
            self._send_json({"error": "not found"}, 404)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        path = u.path
        try:
            if path == "/api/entities/delete":
                body = self._read_json()
                ids = body.get("ids") or []
                also = bool(body.get("also_drawers", False))
                return self._send_json(delete_entities(ids, also_drawers=also))
            if path == "/api/drawers/delete":
                body = self._read_json()
                ids = body.get("ids") or []
                n = delete_drawers(ids)
                return self._send_json({"drawers_deleted": n})
            self._send_json({"error": "not found"}, 404)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7777)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"\nPalace Curator → http://{args.host}:{args.port}\n")
    print(f"  vault:  {VAULT}")
    print(f"  KG db:  {KG_DB}")
    print("  Ctrl-C para detener\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    server.server_close()


if __name__ == "__main__":
    main()
