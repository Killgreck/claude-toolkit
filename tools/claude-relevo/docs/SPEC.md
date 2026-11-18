# SPEC claude-relevo

## Objetivo
El usuario (Fedora 43 en modo lockdown) tiene varias suscripciones de Claude (perfiles de Claude Code) y solo usa Claude Code. Quiere que cuando se acabe el cupo de una cuenta, Claude Code pase a la siguiente automaticamente y SIN interrupciones, hasta agotar todas. Solucion: un proxy local "claude-relevo" al que Claude Code apunta con ANTHROPIC_BASE_URL. El proxy reemplaza el token OAuth por el de la cuenta activa; si la respuesta dice cupo rechazado (429), marca esa cuenta agotada hasta su reset y REPITE la misma peticion con la siguiente cuenta, antes de mandarle nada a Claude Code.

## Datos verificados (capturados de una peticion real con Claude Code 2.1.322, binario __HOME__/.local/bin/claude)
- Con `ANTHROPIC_BASE_URL=http://127.0.0.1:PUERTO`, Claude Code con login de suscripcion manda `POST /v1/messages?beta=true` con `Authorization: Bearer sk-ant-oat01-...`, `anthropic-beta` que incluye `oauth-2025-04-20`, `x-app: cli`, `stream: true`, y en el body `metadata.user_id` = STRING JSON `{"device_id":"...","account_uuid":"<uuid de la cuenta logueada>","session_id":"..."}`.
- Respuesta 200 trae headers: `anthropic-ratelimit-unified-status` (allowed | allowed_warning | rejected), `-unified-reset` (epoch segundos), `-unified-representative-claim` (five_hour | seven_day | ...), `-unified-5h-utilization` (ej "0.26"), `-unified-5h-reset`, `-unified-5h-status`, `-unified-7d-utilization`, `-unified-7d-reset`, `-unified-7d-status`, `-unified-overage-status` (ej "rejected"), `-unified-overage-disabled-reason`, `-unified-fallback-percentage`. En el binario tambien existen `-unified-overage-in-use`, `-unified-overage-reset`, `-unified-overage-utilization`.
- Logica interna de Claude Code: considera limite cuando status==="rejected" y (overage-status ausente o "rejected"); usa unified-reset para el "resets at".

## Perfiles (archivo ~/.config/claude-relevo/cuentas.json, modo 600, dir 700; crealo con este contenido si no existe)
Orden = prioridad. Cada cuenta: `nombre`, `dir` (config dir de Claude), `claudeJson` (ruta del .claude.json para leer `oauthAccount.accountUuid`), opcional `umbral` (0..1, default 1).
- personal1: dir __HOME__/.claude, claudeJson __HOME__/.claude.json (OJO: este perfil NO usa CLAUDE_CONFIG_DIR; su .claude.json vive en el home)
- empresa: dir __HOME__/.claude-empresa, claudeJson __HOME__/.claude-empresa/.claude.json
- personal2: dir __HOME__/.claude-personal2, claudeJson __HOME__/.claude-personal2/.claude.json
Otras opciones globales en el mismo json: `puerto` (default 47800), `evitarExtra` (default true).
Credenciales: `<dir>/.credentials.json` -> `claudeAiOauth.{accessToken, refreshToken, expiresAt(ms), refreshTokenExpiresAt(ms)}`. Releer el archivo cuando cambie su mtime (Claude Code los rota).
Hoy: personal1 VIVA; empresa MUERTA (refreshTokenExpiresAt ya paso); personal2 MUERTA (sin refreshToken). el usuario las reloguea despues.

## Estados de cuenta
- `lista`: token valido o refrescable.
- `agotada` hasta `agotadaHasta` (epoch s): se reactiva sola al pasar la hora.
- `muerta`: sin refreshToken o refreshTokenExpiresAt < ahora, o 401 tras un refresh. Se reevalua cuando cambie el mtime de su .credentials.json (relogin del usuario).
Cuenta activa = la PRIMERA en orden que este `lista`. Asi, cuando la preferida resetea, se vuelve a ella sola.
Persistir agotadaHasta/muertas en ~/.local/state/claude-relevo/estado.json (600) para sobrevivir reinicios.

## Refresco de tokens (sin logica OAuth propia)
El proxy NO llama al endpoint de OAuth. Si el accessToken vence en < 5 min: ejecuta `__HOME__/.local/bin/claude -p /usage --output-format json --no-session-persistence` con env limpio (quitar CLAUDE_CONFIG_DIR, CLAUDECODE, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY; poner CLAUDE_CONFIG_DIR=<dir> solo si la cuenta no es personal1), timeout 60 s, una sola vez a la vez por cuenta (single-flight), y luego relee el archivo. Es comando local de Claude que NO gasta cupo y dispara el refresh. PROHIBIDO correrlo sobre una cuenta `muerta` (si el refresh ya vencio, Claude borra el refreshToken).
Mantener vivas: cada 6 h, para cada cuenta `lista` cuyo refreshTokenExpiresAt este a menos de 7 dias, correr ese mismo refresco (los refresh tokens mueren a ~25 dias sin uso).

## Ruteo
- Solo escucha en 127.0.0.1:<puerto>.
- Llave: ~/.config/claude-relevo/llave (600, 32 bytes hex aleatorios, se crea si falta). Toda peticion debe traer `x-relevo-llave: <llave>` (Claude Code la manda via `ANTHROPIC_CUSTOM_HEADERS`). Sin llave o incorrecta -> 403. Quitar ese header antes de reenviar.
- Rutas `/v1/messages` y `/v1/messages/*` (con query): leer el body completo, elegir cuenta activa, poner `Authorization: Bearer <token de esa cuenta>`, reescribir `account_uuid` dentro del string JSON de `metadata.user_id` al accountUuid de esa cuenta (si se conoce y el campo existe; si no parsea, dejarlo). Reenviar a https://api.anthropic.com mismo path+query.
- Otras rutas: pasar tal cual (incluido el Authorization original), solo quitando la llave.
- Upstream con node:https crudo (NO fetch, porque fetch descomprime solo y rompe content-encoding). Quitar hop-by-hop (host, connection, keep-alive, transfer-encoding, content-length se recalcula). Respuestas: streaming SSE sin buffer, pipe directo. Si el cliente corta, abortar upstream.
- Decision por respuesta (antes de mandar un solo byte al cliente):
  - 429 sin ningun header `anthropic-ratelimit-unified-*` = estrangulamiento pasajero, NO cupo (decision del cerebro, 2026-11-17): la cuenta pasa a `enfriando` 60 s (o `retry-after`, tope 5 min; motivo "429 pasajero"), se reintenta la misma peticion con la siguiente cuenta lista; si no hay otra lista se devuelve ese 429 tal cual (Claude Code reintenta con backoff). No cuenta como cambio por "agotada" en notify-send.
  - 429 con headers unified que indiquen rechazo, o status rejected sin overage permitido: marcar agotada hasta unified-reset (o retry-after, o +1 h si no hay nada), consumir/descartar ese body, reintentar con la siguiente cuenta lista. Si no queda ninguna: devolver a Claude Code el 429 de la cuenta con reset MAS CERCANO (headers+body originales), para que muestre la hora correcta.
  - 401 (revisado 2026-11-17): se relee el archivo; si el token cambio solo, o si el refresco (single-flight, espera minima 60 s por cuenta) lo cambio, se reintenta UNA vez; si aun asi da 401 -> `muerta`. Si el refresco fallo o no cambio nada -> `enfriando` con backoff 2, 5, 15, tope 30 min (la cuenta NO muere). Nunca dejar pasar un 401 causado por un token cambiado; si ninguna cuenta sirve se devuelve el ultimo 401.
  - Cualquier otro status: pasar tal cual (529/5xx los reintenta Claude Code).
- Despues de un 200: guardar utilizacion 5h/7d y resets por cuenta. Si `umbral` < 1 y 5h o 7d utilization >= umbral -> marcar agotada hasta el reset de esa ventana (aplica desde la siguiente peticion). Si `evitarExtra` y (`overage-in-use` == "true" o utilizacion >= 1) y hay otra cuenta lista -> marcar agotada (no pagar uso extra).
- Al cambiar de cuenta activa: log + `notify-send "Claude relevo" "personal1 agotada (5h, vuelve 14:00) -> empresa"` (fire and forget, ignorar si falla).

## Estado y logs
- `GET /__relevo/estado` (con llave): JSON con activa y por cuenta: nombre, estado, agotadaHasta, motivo, util5h, util7d, reset5h, reset7d, refreshTokenExpiresAt, ultimoUso. JAMAS tokens.
- `GET /__relevo/salud` (sin llave): `{"ok":true}`.
- Log en ~/.local/state/claude-relevo/relevo.log (600), una linea por peticion: hora, ruta, cuenta, status, util, cambios. Nunca tokens, nunca bodies.

## CLI y lanzador (dentro del repo, en bin/)
- `bin/claude-relevo`: subcomandos `estado` (tabla legible en espanol desde /__relevo/estado), `log` (tail del log), `servidor` (arranca el proxy en primer plano).
- `bin/claude-auto`: lanzador. Si /__relevo/salud responde -> `exec __HOME__/.local/bin/claude "$@"` con `ANTHROPIC_BASE_URL=http://127.0.0.1:<puerto>`, `ANTHROPIC_CUSTOM_HEADERS="x-relevo-llave: <llave>"` y `ENABLE_TOOL_SEARCH=true` (con base URL no oficial Claude Code apaga tool search por defecto; verifica en el binario que esa variable lo fuerce y anota lo que encuentres). Si el proxy no responde -> aviso corto por stderr y `exec claude "$@"` normal. Nunca debe romper el uso de Claude.
- `systemd/claude-relevo.service` (unidad --user): ExecStart con node 24 `__HOME__/.local/opt/node-v24.21.0-linux-x64/bin/node <repo>/src/relevo.ts`, Restart=on-failure, NoNewPrivileges=yes, PrivateTmp=yes.
- `install.sh`: enlaza bin/* en ~/.local/bin, copia la unidad a ~/.config/systemd/user, daemon-reload, enable --now. NO lo ejecutes.

## Stack
- TypeScript corrido directo por Node 24 (type stripping): solo sintaxis borrable (sin enums, sin parameter properties, imports con extension .ts). tsconfig con `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `strict`, `module/moduleResolution nodenext`, types node.
- CERO dependencias de runtime (solo node:*). DevDependencies: typescript 6.0.x (typescript-eslint no soporta TS 7), @types/node, eslint, @eslint/js, typescript-eslint. Usa el PATH de Node 24: `export PATH=__HOME__/.local/opt/node-v24.21.0-linux-x64/bin:$PATH`. Gotcha npm 11: bloquea install scripts; ninguno de estos los necesita.
- Regla obligatoria del usuario: despues de CADA cambio, `npx tsc --noEmit && npx eslint .` dentro del repo, limpio. Ignora node_modules en eslint.
- git init en el repo y commits pequenos con mensaje en espanol; terminar cada commit con la linea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Sin remoto, sin push.

## Pruebas (regla dura del usuario: solo lo real cuenta como "validado")
Llama a cada cosa por su nombre. Lint/tsc = inspeccion estatica. Un upstream falso local = SIMULACRO (permitido para probar la logica de cambio en 429/401, pero en el reporte va etiquetado SIMULACRO, nunca "validado"). Si usas upstream falso, que sea con una variable `RELEVO_UPSTREAM` que el proxy loguea con WARNING al arrancar.
E2E REAL obligatorio (proxy en puerto de prueba 47899 con config de prueba en tu dir, usando las credenciales reales de los perfiles):
1. `claude -p "Responde solo la palabra: ok" --model haiku --no-session-persistence --strict-mcp-config` desde un dir vacio, a traves del proxy con la llave -> responde ok; el log muestra cuenta personal1, 200 y utilizaciones.
2. curl sin llave -> 403. `/__relevo/salud` -> ok.
3. Orden [personal2, empresa, personal1]: personal2 y empresa quedan `muerta` SIN haber ejecutado claude sobre ellas (demuestralo en el log), y la peticion la sirve personal1.
4. `claude-auto -p ...` con el proxy de prueba (pasale el puerto por env o config de prueba) -> ok. Y con el proxy apagado -> cae a claude normal y responde.
5. Smoke interactivo con tmux: lanzar `bin/claude-auto --model haiku` en una sesion tmux de prueba (cwd vacio en tu dir), mandar "Responde solo la palabra: ok", capture-pane y confirmar respuesta; cerrar la sesion tmux. Nunca toques sesiones tmux que no creaste.
Maximo ~10 peticiones reales al modelo en total (cuidan cupo), siempre haiku.
El cambio REAL entre dos cuentas vivas no se puede probar hoy (solo hay una viva). Deja en README el comando exacto para probarlo cuando el usuario reloguee: poner `umbral: 0.01` a personal1 en una config de prueba -> tras la primera respuesta la siguiente peticion debe ir a la otra cuenta.
No uses el mouse/teclado/pantalla del usuario. No dejes procesos vivos al terminar (ojo: `pkill -f` puede matar tu propio shell; mata por PID).

## README.md (espanol simple)
Que hace, como instalar (install.sh), como usar (claude-auto), como ver estado, como agregar otra cuenta (claude-cuentas login + entrada en cuentas.json), limites conocidos (cambio de cuenta = se pierde el cache de prompt una vez; teleport/remote no disponibles con ANTHROPIC_BASE_URL; lo que encontraste de ENABLE_TOOL_SEARCH).

## Reporte final (corto)
Archivos creados, salida final de `npx tsc --noEmit && npx eslint .`, cada prueba con el comando exacto y la evidencia (lineas de log/salida), separando REAL vs SIMULACRO vs estatico, gaps honestos, y cualquier duda sobre el SPEC. No digas "funciona" de algo que no corriste.

## Revisiones (ronda del verificador, 2026-11-17)
Esta seccion manda sobre lo anterior donde haya conflicto.
1. Ultimo recurso: si no hay ninguna cuenta `lista` se prueban TODAS las no muertas, en este orden: (a) marcas blandas (umbral/evitarExtra) por prioridad, (b) `enfriando` por reset mas cercano, (c) `agotada` por cupo por reset mas cercano. Cada respuesta actualiza su marca. Si todas fallan: el 429 con reset mas cercano.
2. Un 200 solo borra una marca `agotada` puesta ANTES de que saliera esa peticion (se guarda el timestamp de la marca).
3. Refresco: espera minima de 60 s por cuenta entre intentos. Mientras tanto se usa el token actual si no vencio; si ya vencio la cuenta pasa a `enfriando`.
4. `muerta` solo si falta refreshToken, refreshTokenExpiresAt ya paso, o el refresco cambio el token y aun asi hay 401. En otro caso `enfriando` con backoff.
5. Con todas las cuentas muertas (o sin cuentas en la config) `/v1/messages` se reenvia con el Authorization ORIGINAL del cliente y el body sin tocar, como si no hubiera proxy.
6. `account_uuid` se reemplaza en el texto crudo del body, sin parse+stringify: se busca la subcadena exacta `"user_id":` + JSON del valor viejo (espacios opcionales tras los dos puntos) y se cambia solo si aparece EXACTAMENTE una vez; si no, el body va intacto y se loguea un aviso. Prohibido un replace global del uuid.
7. Si el cliente aborta mientras se espera el token o el refresco, no se envia nada upstream.
8. Un aborto del cliente durante la subida del body se loguea como "cliente corto", no como ERROR.
9. El uuid de cada cuenta se cachea; el `.claude.json` se relee como mucho cada 60 s y solo si cambio su mtime.
10. unhandledRejection/uncaughtException se loguean (sin tokens) y el proceso sigue vivo; cada request va en try/catch (502 si no se mandaron headers, destroy si ya).
11. Log: al pasar 5 MB se renombra a relevo.log.1 (se conserva uno); chmod 600 solo al crear.
12. util5h, util7d, resets y ultimoUso se persisten con debounce de 30 s (escritura atomica); los cambios de estado se guardan al instante.
13. `claude-auto` no pisa un `ANTHROPIC_CUSTOM_HEADERS` existente: agrega la llave en otra linea.
14. ENABLE_TOOL_SEARCH: el verificador capturo el body en 2.1.322 y ToolSearch aparece en tools[] con o sin la variable; no cambia nada observable. Se deja en `claude-auto` por si acaso.

## Revisiones ronda 2 (2026-11-17)
A. El estado de cada cuenta guarda el `accountUuid` con el que se puso (`uuidEstado`). Si el uuid leido del perfil cambia, se reinicia todo el estado de esa cuenta y se loguea "<nombre> cambio de cuenta". Si cambia el mtime de `.credentials.json` se salta el cache de 60 s del uuid y se relee `.claude.json` en ese momento.
B. Dos perfiles con el mismo accountUuid: el de menor prioridad queda `duplicada` (motivo "misma cuenta que <nombre>"), fuera de la rotacion y sin refresco nunca. Sale en `estado` y se loguea una vez por cambio.
C. `restaurar()` valida tipos y marcas permitidas de estado.json; lo invalido se descarta con aviso en el log.
D. Un dir o `.credentials.json` inexistente = `muerta` ("sin login"), sin spam; se toma sola al aparecer el archivo. Config real: orden personal1, personal3, personal2, empresa.

E. Presentacion: las cuentas se muestran por correo (`oauthAccount.emailAddress`, en vivo, mismo cache que el uuid) o por `etiqueta` opcional de cuentas.json; sin login "perfil (sin login)". `/__relevo/estado` agrega `correo` y conserva `nombre`; `claude-relevo estado` agrega la columna PERFIL. El nombre del perfil sigue siendo la clave interna.
