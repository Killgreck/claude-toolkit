#!/usr/bin/env bash
# Instala claude-relevo para el usuario actual. Revisalo antes de correrlo.
set -euo pipefail
REPO="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
ln -sf "$REPO/bin/claude-relevo" "$HOME/.local/bin/claude-relevo"
ln -sf "$REPO/bin/claude-auto" "$HOME/.local/bin/claude-auto"

# crea cuentas.json y llave si faltan (no sobreescribe)
"$REPO/bin/claude-relevo" init

cp "$REPO/systemd/claude-relevo.service" "$HOME/.config/systemd/user/claude-relevo.service"
systemctl --user daemon-reload
systemctl --user enable --now claude-relevo.service

echo "Listo. Prueba: claude-relevo estado   y luego: claude-auto"
