#!/usr/bin/env bash
# Regenera este toolkit publico desde el PC principal. Lo llama sync.sh del repo privado.
#
#   ./export.sh --privado <carpeta config del repo privado> [--push]
#
# Copia skills propias, settings, MCP, hooks, scripts y herramientas; cambia la ruta del
# home por __HOME__ (install.sh la vuelve a poner).
# De la carpeta privada lee (asi esos datos nunca quedan en este repo publico):
#   denylist.txt      palabras que no pueden salir (nombres, cuentas, IPs); si aparecen, NO sube
#   reemplazos.sed    reemplazos de texto (ej. nombre propio -> "usuario")
#   mcp-privados.txt  servidores MCP que no se publican
# Ademas corre gitleaks. Si encuentra algo, NO sube.
set -euo pipefail
T="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PRIV=""; PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --privado) PRIV="$2"; shift 2 ;;
    --push) PUSH=1; shift ;;
    *) echo "uso: $0 --privado <carpeta> [--push]"; exit 1 ;;
  esac
done
DENY="$PRIV/denylist.txt"
[ -n "$PRIV" ] && [ -f "$DENY" ] || { echo "export: falta --privado <carpeta con denylist.txt>"; exit 1; }
SED_PRIV="$PRIV/reemplazos.sed"; [ -f "$SED_PRIV" ] || SED_PRIV=/dev/null
MCP_PRIV="$PRIV/mcp-privados.txt"; [ -f "$MCP_PRIV" ] || MCP_PRIV=/dev/null
log() { echo "[$(date +%H:%M:%S)] toolkit: $*"; }
H="$HOME"
B="$H/.local/bin"
cd "$T"

# --- carpetas que se regeneran completas en cada export ---
rm -rf skills bin tools mcp hooks settings
mkdir -p skills bin tools mcp hooks settings

for s in caverman reunion; do
  [ -d "$H/.claude/skills/$s" ] && rsync -a --exclude '.trash' "$H/.claude/skills/$s/" "skills/$s/"
done

for b in claude-auto claude-cuentas claude-empresa claude-personal1 claude-personal2 claude-mover \
         claude-notify gemini-notify lid-screen-off.sh obsidian; do
  [ -f "$B/$b" ] && cp -p "$B/$b" bin/
done

if [ -d "$H/projects/claude-relevo/.git" ]; then
  mkdir -p tools/claude-relevo
  git -C "$H/projects/claude-relevo" archive HEAD | tar x -C tools/claude-relevo
fi
if [ -d "$H/projects/reunion" ]; then
  mkdir -p tools/reunion
  cp -p "$H/projects/reunion/reunion" "$H/projects/reunion/transcriber.py" tools/reunion/
fi
[ -f "$H/.local/share/claude-accounts/accounts.py" ] && mkdir -p tools/claude-cuentas \
  && cp -p "$H/.local/share/claude-accounts/accounts.py" tools/claude-cuentas/

if [ -d "$H/mempalace-obsidian-bridge/scripts" ]; then
  mkdir -p hooks/mempalace-obsidian-bridge
  rsync -a --exclude __pycache__ "$H/mempalace-obsidian-bridge/scripts/" hooks/mempalace-obsidian-bridge/scripts/
fi

if [ -d "$H/desktop-control-mcp" ]; then
  mkdir -p mcp/desktop-control-mcp
  cp -p "$H/desktop-control-mcp/server.js" "$H/desktop-control-mcp/README.md" mcp/desktop-control-mcp/ 2>/dev/null || true
fi
if [ -d "$H/whatsapp-mcp/.git" ]; then
  mkdir -p mcp/whatsapp-mcp
  git -C "$H/whatsapp-mcp" diff -- whatsapp-bridge/main.go whatsapp-bridge/go.mod whatsapp-bridge/go.sum \
    > mcp/whatsapp-mcp/whatsapp-bridge.patch
  git -C "$H/whatsapp-mcp" rev-parse HEAD > mcp/whatsapp-mcp/UPSTREAM_COMMIT
fi
if [ -f "$H/.config/workspace-mcp/run.sh" ]; then
  mkdir -p mcp/workspace-mcp
  cp -p "$H/.config/workspace-mcp/run.sh" mcp/workspace-mcp/run.sh
  printf 'GOOGLE_OAUTH_CLIENT_ID=PEGAR_AQUI\nGOOGLE_OAUTH_CLIENT_SECRET=PEGAR_AQUI\n' > mcp/workspace-mcp/env.example
fi

python3 - "$H" "$MCP_PRIV" <<'EOF'
import json, os, sys
H = sys.argv[1]
privados = {l.strip() for l in open(sys.argv[2]) if l.strip() and not l.startswith("#")}
def limpiar(v):
    if isinstance(v, dict): return {k: limpiar(x) for k, x in v.items()}
    if isinstance(v, list): return [limpiar(x) for x in v]
    if isinstance(v, str): return v.replace(H, "__HOME__")
    return v
d = json.load(open(os.path.join(H, ".claude.json")))
srv = dict(d.get("mcpServers", {}))
for p, v in d.get("projects", {}).items():
    if p == H:
        srv.update(v.get("mcpServers", {}))
for n in privados:
    srv.pop(n, None)
for s in srv.values():
    if s.get("env"):
        s["env"] = {k: "PEGAR_AQUI" for k in s["env"]}
json.dump(limpiar(srv), open("mcp/servers.json", "w"), indent=2, ensure_ascii=False)
st = json.load(open(os.path.join(H, ".claude", "settings.json")))
st.pop("remote", None)
json.dump(limpiar(st), open("settings/settings.json", "w"), indent=2, ensure_ascii=False)
EOF

# --- sanear: ruta del home + reemplazos privados ---
while IFS= read -r -d '' f; do
  file -b --mime "$f" | grep -q 'charset=binary' && continue
  sed -i -e "s#$H#__HOME__#g" -f "$SED_PRIV" "$f"
done < <(find skills bin tools mcp hooks settings -type f -print0)

# --- control: lista negra + gitleaks ---
mal=0
patrones="$(mktemp)"; trap 'rm -f "$patrones"' EXIT
grep -v '^#' "$DENY" | grep -v '^[[:space:]]*$' > "$patrones"
if hits="$(grep -rniwF -f "$patrones" --exclude-dir=.git . 2>/dev/null)"; then
  log "ALTO: datos personales en el toolkit:"; echo "$hits" | cut -c1-200 | head -30; mal=1
fi
GL="$(command -v gitleaks || echo "$H/.local/opt/gitleaks/gitleaks")"
if [ -x "$GL" ]; then
  if ! "$GL" dir . --no-banner --redact --exit-code 1 >/dev/null 2>&1; then
    log "ALTO: gitleaks ve secretos:"; "$GL" dir . --no-banner --redact 2>&1 | grep -E 'File|RuleID|Line' | head -30; mal=1
  fi
else
  log "ALTO: no encuentro gitleaks"; mal=1
fi
[ "$mal" = 0 ] || { log "no subo nada"; exit 3; }
log "limpio (lista negra + gitleaks)"

chmod +x bin/* tools/reunion/reunion 2>/dev/null || true
if [ "$PUSH" = 1 ]; then
  git add -A
  if git diff --cached --quiet; then log "sin cambios"; else
    git commit -q -m "export $(date '+%Y-%m-%d %H:%M')"; log "commit $(git rev-parse --short HEAD)"
  fi
  git remote get-url origin >/dev/null 2>&1 && git pull --rebase -q && git push -q && log "subido"
fi
