---
name: reunion
description: Acompañar al usuario en reuniones virtuales (Meet/Teams/Zoom) grabando y transcribiendo en vivo y local con la herramienta `reunion` (~/projects/reunion). Úsalo cuando el usuario diga "reunión", "estoy en reunión", "graba la reunión", "empieza/para la reunión", "qué dijo", "qué le pregunto", "resumen de la reunión", o /reunion.
---

# Reunion: Claude escucha la reunión por el PC del usuario

Claude NO entra a la reunión (no habla ni aparece como participante). La herramienta graba en este PC dos pistas, el audio del PC (OTROS) y el micrófono (USUARIO), y las transcribe cada 30 s con faster-whisper local. Claude lee el texto con Bash y le ayuda al usuario en el terminal.

## Comandos (`~/.local/bin/reunion` → `~/projects/reunion/reunion`)

```bash
REUNION_CONTEXTO="Proyecto X, Ana, Luis" reunion empezar "proyecto x"   # vuelve enseguida, todo queda corriendo
reunion estado          # procesos vivos, atraso y volumen de cada pista (avisa SILENCIO si una fuente está muda)
reunion ver 60          # últimas 60 líneas (activa, o la última si no hay activa)
reunion parar           # corta, junta el audio en .opus; la transcripción limpia sigue en segundo plano
reunion lista
```

Carpeta por reunión: `~/reuniones/AAAA-MM-DD_HHMM_nombre/` (chmod 700). Adentro: `transcripcion.md` (en vivo), `transcripcion_final.md` (pasada limpia sobre el audio completo; existe cuando aparece el archivo `FINAL`), `otros.opus`, `usuario.opus`, `reunion.opus` (mezcla), `transcriber.log`. `~/reuniones/ACTIVA` apunta a la reunión en curso. El vigía la corta sola cuando el usuario cuelga: si la app que tenía el mic (Chrome con Meet o Teams) lo suelta por más de `REUNION_FIN_SEG` (60 s), hace `parar`. Silenciarse en la llamada no suelta el mic. Si nunca vio una llamada, corta a las 3 h (`REUNION_MAX_HORAS`). Lo que hace el vigía queda en `vigia.log`, y `reunion estado` muestra qué app tiene el mic.

Otras variables: `REUNION_MODELO` (por defecto `large-v3-turbo`; `small` si el PC no da abasto), `REUNION_HILOS` (4), `REUNION_FUENTE_OTROS` y `REUNION_FUENTE_MIGUEL` (nombres de fuentes de PipeWire/Pulse; por defecto el monitor de la salida por defecto y la entrada por defecto).

## Antes de empezar

- La reunión tiene que ir en Chrome de ESTE PC, no en el celular.
- Audífonos: con parlante, el mic también capta a los otros y sus frases salen duplicadas como USUARIO.
- Si va a usar audífonos USB, que los conecte ANTES de `reunion empezar` (la fuente se fija al arrancar). Si no suenan, puede ser USBGuard bloqueándolos en silencio.
- Recordarle que avise al inicio que va a grabar el audio para tomar nota.
- Poner en `REUNION_CONTEXTO` los nombres propios y términos del tema; whisper los escribe mejor.

## Durante

- Cuando el usuario pregunte algo, correr `reunion ver 60` y responder corto, en tono caverman, con preguntas o respuestas concretas que él pueda decir.
- OTROS junta a todos los demás, sin separar quién habla; deducir quién es por el contexto.
- Al minuto de empezar correr `reunion estado`: si una pista sale SILENCIO, avisar al usuario YA (fuente equivocada o mic silenciado).
- La transcripción va unos 30 a 60 s atrás. Si `reunion estado` muestra que el atraso crece, el CPU no alcanza: la próxima vez usar `REUNION_MODELO=small`.
- La versión en vivo corta palabras cada 30 s; no corregir al usuario por eso.

## Después

1. Normalmente ya se cortó sola al colgar (mirar `vigia.log`). Si no, `reunion parar`.
2. Esperar `FINAL` en la carpeta y leer `transcripcion_final.md` (si tarda, trabajar con `transcripcion.md`).
3. Escribir `resumen.md` en la misma carpeta: acuerdos, cambios pedidos o alcance, pendientes con dueño y fecha, preguntas abiertas y citas textuales clave con su hora.
4. Actualizar la memoria del proyecto que corresponda.
5. Nada sale a terceros: si hay que mandar algo, se hace borrador y el usuario da el OK.

## Reglas

- El audio nunca se sube a un servicio externo de transcripción.
- No usar mouse, teclado ni pantalla del usuario para nada de esto.
- Detener procesos solo con `reunion parar` (para por PID guardado; `pkill -f` se mata solo).
