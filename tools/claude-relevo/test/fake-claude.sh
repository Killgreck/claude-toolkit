#!/usr/bin/env bash
# SIMULACRO: claude falso. Registra la invocacion y, si existe .rotar en el dir,
# reescribe .credentials.json con el token nuevo que ese archivo contiene.
DIR="${CLAUDE_CONFIG_DIR:-SIN_CONFIG_DIR}"
echo "$(date +%s) dir=$DIR args=$*" >> "$FAKE_CLAUDE_LOG"
if [ -f "$DIR/.rotar" ]; then
  NUEVO="$(cat "$DIR/.rotar")"
  FUTURO=$(( ($(date +%s) + 36000) * 1000 ))
  printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"r-%s","expiresAt":%s,"refreshTokenExpiresAt":%s}}\n' "$NUEVO" "$NUEVO" "$FUTURO" "$((FUTURO*3))" > "$DIR/.credentials.json"
  rm -f "$DIR/.rotar"
fi
sleep 0.2
echo '{}'
