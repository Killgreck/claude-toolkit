# claude-relevo

Proxy local que pasa Claude Code de una cuenta a la siguiente cuando a una se le acaba el cupo, sin que Claude Code se entere.

## Que hace

Claude Code apunta al proxy (`ANTHROPIC_BASE_URL`). El proxy cambia el token por el de la cuenta activa. Si Anthropic contesta "cupo agotado" (429), marca esa cuenta como agotada hasta su hora de reset y repite la misma peticion con la siguiente cuenta, antes de devolverle nada a Claude Code. Cuando la cuenta preferida resetea, vuelve a ella sola. Si ninguna tiene cupo, Claude Code recibe el 429 de la que resetea antes, con la hora correcta.

Si ninguna cuenta esta lista, prueba todas las demas (primero las apartadas por umbral, luego las enfriando, luego las agotadas por cupo) hasta que una sirva. Si todas estan muertas (o no hay cuentas), reenvia la peticion con tu login original, como si no hubiera proxy. Una cuenta no pasa a muerta por un 401 suelto: solo si le falta el refresh token, este vencio, o el token se renovo y aun asi da 401; en otro caso queda enfriando 2, 5, 15 y hasta 30 min.

Orden y prioridad: el de `~/.config/claude-relevo/cuentas.json` (personal1, empresa, personal2).

## Instalar

Revisa `install.sh` y luego:

    ./install.sh

Enlaza `claude-relevo` y `claude-auto` en `~/.local/bin`, crea `cuentas.json` y la llave si faltan, copia la unidad systemd de usuario y la arranca.

## Usar

    claude-auto            # en vez de claude; acepta los mismos argumentos
    claude-relevo estado   # tabla con cuenta activa, uso 5h/7d, resets
    claude-relevo log -f   # log en vivo (~/.local/state/claude-relevo/relevo.log)

`claude-auto` pasa todas las banderas tal cual a claude, por ejemplo `claude-auto --dangerously-skip-permissions`.

`claude-auto` revisa que el proxy responda. Si no responde, avisa por stderr y lanza claude normal. Usa el perfil por defecto (`~/.claude`) o el que tengas en `CLAUDE_CONFIG_DIR`; el proxy pone el token de la cuenta activa de todas formas, pero Claude Code necesita un login local que no este muerto para arrancar.

## Como se muestran las cuentas

En `claude-relevo estado`, el log, las notificaciones y `/__relevo/estado` (campo `correo`, junto a `nombre`) cada cuenta sale por su correo, leido en vivo de `oauthAccount.emailAddress` del `.claude.json` del perfil (si el perfil cambia de cuenta, cambia solo). Si una entrada de `cuentas.json` tiene `"etiqueta": "empresa"`, se muestra la etiqueta en vez del correo. Sin login o sin correo legible sale `perfil (sin login)`. La ultima columna, PERFIL, es el nombre del perfil (personal1, personal3...): ese es el que usas con `claude-cuentas login`. El nombre del perfil sigue siendo la clave interna (`estado.json`, duplicadas).

## Agregar otra cuenta

1. `claude-cuentas login <nombre>` (crea el perfil y hace el login).
2. Agrega una entrada en `~/.config/claude-relevo/cuentas.json`: `{"nombre": "...", "dir": "...", "claudeJson": ".../.claude.json"}`. Opcional: `"umbral": 0.9` (pasa a la siguiente al llegar a 90% de 5h o 7d).
3. `systemctl --user restart claude-relevo` (el proxy relee `cuentas.json` solo al arrancar; los logins nuevos de perfiles ya listados los detecta solo).

Ejemplo con una cuenta cuyo perfil aun no existe (cuenta como `muerta`, motivo "sin login", sin errores; se activa sola cuando aparezca `.credentials.json`). Orden de prioridad = orden de la lista:

    {"nombre":"personal3","dir":"__HOME__/.claude-personal3","claudeJson":"__HOME__/.claude-personal3/.claude.json"}

Si cambias de cuenta con `/login` dentro de un perfil, el proxy lo nota por el `accountUuid` y reinicia el estado de ese perfil (nada heredado de la cuenta anterior). Si dos perfiles quedan con la misma cuenta, el de menor prioridad pasa a `duplicada`: fuera de la rotacion y sin refresco (se ve en `claude-relevo estado`).

Opciones globales en el mismo json: `puerto` (47800) y `evitarExtra` (true: no usa credito extra si hay otra cuenta).

## Como se mantienen los tokens

El proxy no habla con el OAuth. Si un token vence en menos de 5 minutos (como mucho una vez por minuto por cuenta), corre `claude -p /usage` sobre ese perfil (no gasta cupo) y relee el archivo. Nunca lo corre sobre cuentas muertas. Cada 6 h hace lo mismo con las cuentas cuyo refresh token vence en menos de 7 dias. Los `.credentials.json` son solo lectura para el proxy.

## Probar el cambio real entre cuentas (cuando relogueen empresa o personal2)

Con una config de prueba, `umbral: 0.01` en personal1 hace que tras la primera respuesta la siguiente peticion vaya a la otra cuenta:

    export PATH=__HOME__/.local/opt/node-v24.21.0-linux-x64/bin:$PATH
    cd __HOME__/projects/claude-relevo
    mkdir -p prueba/cfgC prueba/estC
    cat > prueba/cfgC/cuentas.json <<'JSON'
    {"puerto":47898,"cuentas":[
     {"nombre":"personal1","dir":"__HOME__/.claude","claudeJson":"__HOME__/.claude.json","umbral":0.01},
     {"nombre":"empresa","dir":"__HOME__/.claude-empresa","claudeJson":"__HOME__/.claude-empresa/.claude.json"}]}
    JSON
    export RELEVO_CONFIG_DIR=$PWD/prueba/cfgC RELEVO_STATE_DIR=$PWD/prueba/estC RELEVO_SIN_NOTIFY=1
    bin/claude-relevo init
    node src/relevo.ts &  PID=$!
    sleep 1
    for i in 1 2; do bin/claude-auto -p "Responde solo la palabra: ok" --model haiku --no-session-persistence --strict-mcp-config </dev/null; done
    bin/claude-relevo log   # la 1a linea debe decir cuenta=personal1, la 2a cuenta=empresa
    kill $PID

## Pruebas

    npx tsc --noEmit && npx eslint .        # estatico
    node --test test/simulacro.test.ts      # SIMULACRO: upstream falso (RELEVO_UPSTREAM) y claude falso

Variables de prueba: `RELEVO_CONFIG_DIR`, `RELEVO_STATE_DIR`, `RELEVO_PUERTO`, `RELEVO_UPSTREAM` (loguea WARNING), `RELEVO_CLAUDE_BIN`, `RELEVO_SIN_NOTIFY=1`.

## Limites conocidos

- Al cambiar de cuenta se pierde el cache de prompt una vez (la primera respuesta es mas lenta/cara en tokens de entrada).
- Con `ANTHROPIC_BASE_URL` no funcionan teleport ni remote.
- ENABLE_TOOL_SEARCH: en Claude Code 2.1.322 no cambia nada observable. Se capturo el body de una peticion y ToolSearch aparece en `tools[]` con o sin la variable. `claude-auto` la sigue exportando por si una version futura apaga tool search con base URL no oficial.
- La llave del proxy queda en el entorno (`ANTHROPIC_CUSTOM_HEADERS`) de Claude Code y de todos los subprocesos que lance. Solo sirve para hablar con el proxy local (127.0.0.1), pero no la compartas. `claude-auto` agrega la llave a un `ANTHROPIC_CUSTOM_HEADERS` que ya tengas, no lo pisa.
- Un 429 sin headers `anthropic-ratelimit-unified-*` se trata como estrangulamiento pasajero, no como cupo: la cuenta queda `enfriando` 60 s (o el `retry-after`, maximo 5 min) y se prueba la siguiente; si no hay otra, el 429 pasa tal cual a Claude Code. Solo un rechazo unified marca la cuenta agotada hasta su reset.
- Una cuenta con refresh token vencido (muerta) solo vuelve cuando se reloguea y cambia su `.credentials.json`.
- Solo escucha en 127.0.0.1 y exige la llave `x-relevo-llave`; el log nunca guarda tokens ni bodies.
