#!/usr/bin/env bash
# Deja un PC nuevo con las mismas herramientas de Claude Code que el PC principal.
#
#   git clone https://github.com/Killgreck/claude-toolkit ~/claude-sync/claude-toolkit
#   ~/claude-sync/claude-toolkit/install.sh                 # herramientas + memoria privada
#   ~/claude-sync/claude-toolkit/install.sh --sin-memoria   # solo herramientas
#
# Se puede correr varias veces: no pisa lo que ya existe (salvo settings.json, que respalda).
set -euo pipefail
T="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
MEMORIA=1; [ "${1:-}" = --sin-memoria ] && MEMORIA=0
REPO_MEMORIA="${CLAUDE_MEMORIA_REPO:-Killgreck/claude-memoria}"
PENDIENTES=()
log() { echo "[install] $*"; }
pendiente() { PENDIENTES+=("$*"); }
tiene() { command -v "$1" >/dev/null 2>&1; }
con_home() { sed "s#__HOME__#$HOME#g" "$1"; }
copiar_con_home() {  # copia carpeta $1 -> $2 cambiando __HOME__ en los archivos de texto
  mkdir -p "$2"; rsync -a "$1/" "$2/"
  grep -rlI '__HOME__' "$2" 2>/dev/null | while read -r f; do sed -i.tmp "s#__HOME__#$HOME#g" "$f" && rm -f "$f.tmp"; done
}

# 0. requisitos
for c in git python3 curl rsync; do tiene "$c" || { echo "Falta $c. Instalalo y repite."; exit 1; }; done
tiene node || pendiente "Instalar Node.js 20+ (para claude-relevo, desktop-control y varios MCP)"
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
if ! tiene uv; then log "instalando uv"; curl -LsSf https://astral.sh/uv/install.sh | sh; fi

# 1. Claude Code
if ! tiene claude; then log "instalando Claude Code"; curl -fsSL https://claude.ai/install.sh | bash; fi

# 2. skills propias
mkdir -p "$HOME/.claude/skills"
for s in "$T"/skills/*/; do
  n="$(basename "$s")"; copiar_con_home "$s" "$HOME/.claude/skills/$n"; log "skill $n"
done

# 3. scripts
for b in "$T"/bin/*; do
  n="$(basename "$b")"; con_home "$b" > "$HOME/.local/bin/$n"; chmod +x "$HOME/.local/bin/$n"
done
log "scripts en ~/.local/bin: $(ls "$T/bin" | tr '\n' ' ')"

# 4. herramientas (mismas rutas que en el PC principal)
[ -d "$HOME/projects/claude-relevo" ] || { copiar_con_home "$T/tools/claude-relevo" "$HOME/projects/claude-relevo"
  (cd "$HOME/projects/claude-relevo" && tiene npm && npm ci --silent) || pendiente "claude-relevo: correr npm ci en ~/projects/claude-relevo"
  pendiente "claude-relevo: el CLI busca Node 24 en ~/.local/opt; si no esta, exporta RELEVO_NODE=\$(command -v node)"; }
[ -d "$HOME/projects/reunion" ] || { copiar_con_home "$T/tools/reunion" "$HOME/projects/reunion"
  chmod +x "$HOME/projects/reunion/reunion"; ln -sf "$HOME/projects/reunion/reunion" "$HOME/.local/bin/reunion"
  pendiente "reunion: necesita ffmpeg, pipewire/pulse y 'pip install faster-whisper'"; }
mkdir -p "$HOME/.local/share/claude-accounts"
[ -f "$HOME/.local/share/claude-accounts/accounts.py" ] || con_home "$T/tools/claude-cuentas/accounts.py" > "$HOME/.local/share/claude-accounts/accounts.py"
[ -d "$HOME/mempalace-obsidian-bridge" ] || copiar_con_home "$T/hooks/mempalace-obsidian-bridge" "$HOME/mempalace-obsidian-bridge"

# 5. codigo de los MCP locales
[ -d "$HOME/desktop-control-mcp" ] || { copiar_con_home "$T/mcp/desktop-control-mcp" "$HOME/desktop-control-mcp"
  pendiente "desktop-control: solo X11 (xdotool + scrot); ver ~/desktop-control-mcp/README.md"; }
if [ ! -d "$HOME/whatsapp-mcp" ]; then
  git clone -q https://github.com/lharries/whatsapp-mcp "$HOME/whatsapp-mcp"
  (cd "$HOME/whatsapp-mcp" && git checkout -q "$(cat "$T/mcp/whatsapp-mcp/UPSTREAM_COMMIT")" \
     && git apply "$T/mcp/whatsapp-mcp/whatsapp-bridge.patch") && log "whatsapp-mcp clonado + parche"
  pendiente "WhatsApp: cd ~/whatsapp-mcp/whatsapp-bridge && go run main.go  (escanear QR con el celular)"
fi
if [ ! -f "$HOME/.config/workspace-mcp/run.sh" ]; then
  mkdir -p "$HOME/.config/workspace-mcp"
  con_home "$T/mcp/workspace-mcp/run.sh" > "$HOME/.config/workspace-mcp/run.sh"; chmod 700 "$HOME/.config/workspace-mcp/run.sh"
  cp "$T/mcp/workspace-mcp/env.example" "$HOME/.config/workspace-mcp/env"; chmod 600 "$HOME/.config/workspace-mcp/env"
  pendiente "Google Docs MCP: poner client id/secret de Google Cloud en ~/.config/workspace-mcp/env"
fi
if [ ! -d "$HOME/mempalace" ]; then
  git clone -q https://github.com/Killgreck/mempalace "$HOME/mempalace"
  python3 -m pip install -q --user -e "$HOME/mempalace" 2>/dev/null \
    || python3 -m pip install -q --user --break-system-packages -e "$HOME/mempalace" \
    || pendiente "mempalace: pip install -e ~/mempalace"
  pendiente "mempalace: correr 'mempalace init' (palacio vacio; los recuerdos manuales vienen en el repo privado)"
fi

# 6. registrar servidores MCP (alcance usuario)
if tiene claude; then
  python3 - "$T/mcp/servers.json" "$HOME" <<'EOF' | while IFS=$'\t' read -r nombre js; do
import json, sys
srv = json.loads(open(sys.argv[1]).read().replace("__HOME__", sys.argv[2]))
for n, c in srv.items():
    print(n + "\t" + json.dumps(c))
EOF
    if claude mcp get "$nombre" >/dev/null 2>&1; then log "MCP $nombre ya estaba"
    else claude mcp add-json -s user "$nombre" "$js" >/dev/null && log "MCP $nombre agregado"; fi
  done
  pendiente "MCP con login web (Linear, Canva): entrar con /mcp dentro de Claude"
  pendiente "aws-mcp: necesita credenciales AWS ('aws login' o ~/.aws)"
fi

# 7. settings.json (respaldo + mezcla; lo del toolkit gana)
mkdir -p "$HOME/.claude"
python3 - "$T/settings/settings.json" "$HOME" <<'EOF'
import json, os, shutil, sys, time
tpl = json.loads(open(sys.argv[1]).read().replace("__HOME__", sys.argv[2]))
dst = os.path.join(sys.argv[2], ".claude", "settings.json")
cur = {}
if os.path.exists(dst):
    shutil.copy2(dst, dst + time.strftime(".antes-toolkit-%Y%m%d-%H%M%S"))
    cur = json.load(open(dst))
for k, v in tpl.items():
    if isinstance(v, dict) and isinstance(cur.get(k), dict):
        cur[k] = {**cur[k], **v}
    else:
        cur[k] = v
json.dump(cur, open(dst, "w"), indent=2, ensure_ascii=False)
print("[install] settings.json mezclado")
EOF

# 8. plugins de terceros
if tiene claude; then
  claude plugin marketplace add Leonxlnx/taste-skill >/dev/null 2>&1 || true
  claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill >/dev/null 2>&1 || true
  claude plugin install taste-skill@taste-skill >/dev/null 2>&1 || pendiente "plugin taste-skill: /plugin install taste-skill@taste-skill"
  claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill >/dev/null 2>&1 || pendiente "plugin ui-ux-pro-max: /plugin install ui-ux-pro-max@ui-ux-pro-max-skill"
fi

# 9. memoria privada (solo si tu cuenta de GitHub tiene acceso)
if [ "$MEMORIA" = 1 ]; then
  M="$HOME/claude-sync/claude-memoria"
  if [ ! -d "$M/.git" ]; then
    if tiene gh && gh auth status >/dev/null 2>&1; then
      gh repo clone "$REPO_MEMORIA" "$M" -- -q && chmod 700 "$M"
    else
      pendiente "Memoria: instala gh, corre 'gh auth login' y repite install.sh"
    fi
  fi
  [ -x "$M/restore.sh" ] && "$M/restore.sh"
  [ -d "$M/.git" ] && pendiente "Memoria al dia: activa el timer (ver README, seccion 'Sincronizar solo')"
fi

echo
log "listo"
if [ ${#PENDIENTES[@]} -gt 0 ]; then
  echo "Falta a mano:"; for p in "${PENDIENTES[@]}"; do echo "  - $p"; done
fi
