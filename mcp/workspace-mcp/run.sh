#!/usr/bin/env bash
# Lanzador de workspace-mcp para Claude Code.
#
# Se envuelve en un script en vez de poner las variables en la configuracion de
# Claude porque el client_secret quedaria en texto plano dentro de ~/.claude.json,
# que no tiene permisos 600.
#
# Alcance deliberadamente recortado:
#   --tools docs drive   Solo Google Docs y Drive. Nada de Gmail, Calendar,
#                        Contacts, Chat ni Sheets. Google no concede permisos
#                        por documento, asi que recortar por servicio es el
#                        unico control real que existe.
#   --single-user        Un solo dueno de credenciales; sin mapeo de sesiones.
#   stdio                Claude Code arranca el proceso y habla por tuberia. No
#                        deja un servidor HTTP escuchando entre corridas.

set -euo pipefail

CONFIG_DIR="__HOME__/.config/workspace-mcp"

# shellcheck source=/dev/null
set -a
source "${CONFIG_DIR}/env"
set +a

if [[ "${GOOGLE_OAUTH_CLIENT_ID}" == "PEGAR_AQUI" ]]; then
    echo "ERROR: falta completar ${CONFIG_DIR}/env con las credenciales de Google Cloud Console." >&2
    exit 1
fi

# Los tokens de refresco viven aqui, no en el directorio de trabajo.
export WORKSPACE_MCP_CREDENTIALS_DIR="${CONFIG_DIR}/credentials"

# El servidor de callback OAuth escucha en 0.0.0.0 por omision. En una maquina
# en modo lockdown eso es innecesario: el navegador que responde el callback es
# local. Se ata a loopback.
export WORKSPACE_MCP_HOST="127.0.0.1"
export WORKSPACE_MCP_PORT="8000"

exec __HOME__/.local/bin/uvx workspace-mcp \
    --transport stdio \
    --single-user \
    --tools docs drive
