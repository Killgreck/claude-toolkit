#!/usr/bin/env python3
"""Transcribe en vivo los trozos que graba `reunion`.

Dos pistas por reunion: `otros` (lo que suena en el PC) y `usuario` (el mic).
ffmpeg corta cada pista en trozos de SEG segundos; este proceso espera a que
cada trozo quede cerrado, lo pasa por faster-whisper y agrega las lineas,
ordenadas por tiempo, a transcripcion.md. Al recibir PARAR procesa lo que
falte, junta el audio en .opus y borra los .wav.
"""
import datetime
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel

d = Path(sys.argv[1])
MODELO = os.environ.get("REUNION_MODELO", "large-v3-turbo")
IDIOMA = os.environ.get("REUNION_IDIOMA", "es")
HILOS = int(os.environ.get("REUNION_HILOS", "4"))
SEG = int(os.environ.get("REUNION_SEG", "30"))
CONTEXTO = os.environ.get("REUNION_CONTEXTO", "").strip()
PISTAS = [("otros", "OTROS"), ("usuario", "USUARIO")]

# Frases que whisper inventa sobre silencio o ruido.
ALUCINACION = re.compile(
    r"amara\.org|subt[ií]tulos|gracias por ver|suscr[ií]bete|www\.|\.com\b",
    re.IGNORECASE,
)


def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


def vivo(pista):
    try:
        os.kill(int((d / f"pid_{pista}").read_text()), 0)
        return True
    except (OSError, ValueError):
        return False


def trozo(pista, i):
    return d / f"{pista}_{i:04d}.wav"


inicio = datetime.datetime.fromisoformat((d / "inicio").read_text().strip())
salida = d / "transcripcion.md"
if not salida.exists():
    salida.write_text(f"# Reunion {d.name}\n\ninicio: {inicio:%Y-%m-%d %H:%M}\n\n")

log(f"cargando {MODELO} ({HILOS} hilos)")
modelo = WhisperModel(MODELO, device="cpu", compute_type="int8", cpu_threads=HILOS)
ultimo = {p: "" for p, _ in PISTAS}  # cola de texto por pista, sirve de contexto al siguiente trozo

i = 0
while True:
    parado = (d / "PARAR").exists()
    listos, esperar = {}, False
    for p, _ in PISTAS:
        f, sig = trozo(p, i), trozo(p, i + 1)
        terminada = parado or not vivo(p)
        if f.exists() and (sig.exists() or terminada):
            listos[p] = f
        elif not f.exists() and terminada:
            listos[p] = None
        else:
            esperar = True

    if esperar:
        time.sleep(2)
        continue
    if not any(listos.values()):
        break  # las dos pistas terminaron y no quedan trozos

    t0 = time.time()
    lineas = []
    for p, etiqueta in PISTAS:
        if not listos[p]:
            continue
        prompt = " ".join(x for x in (CONTEXTO, ultimo[p][-200:]) if x) or None
        segs, _ = modelo.transcribe(
            str(listos[p]), language=IDIOMA, vad_filter=True, beam_size=1,
            initial_prompt=prompt, condition_on_previous_text=False,
        )
        for s in segs:
            texto = s.text.strip()
            if not texto or s.no_speech_prob > 0.6 or ALUCINACION.search(texto):
                continue
            lineas.append((i * SEG + s.start, etiqueta, texto))
            ultimo[p] = (ultimo[p] + " " + texto)[-400:]
    lineas.sort()
    with salida.open("a") as fh:
        for t, etiqueta, texto in lineas:
            hora = inicio + datetime.timedelta(seconds=t)
            fh.write(f"[{hora:%H:%M:%S}] {etiqueta}: {texto}\n")
    (d / "estado").write_text(f"{i + 1} trozos transcritos, ultimo a las {datetime.datetime.now():%H:%M:%S}\n")
    log(f"trozo {i}: {len(lineas)} lineas en {time.time() - t0:.1f}s")
    i += 1

# Juntar el audio: una pista .opus por lado y una mezcla para escuchar.
for p, _ in PISTAS:
    wavs = sorted(d.glob(f"{p}_*.wav"))
    if not wavs:
        continue
    lista = d / f"lista_{p}.txt"
    lista.write_text("".join(f"file '{w.name}'\n" for w in wavs))
    r = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", str(lista), "-c:a", "libopus", "-b:a", "24k", str(d / f"{p}.opus")],
    )
    if r.returncode == 0:
        for w in wavs:
            w.unlink()
        lista.unlink()
    else:
        log(f"no pude juntar {p}, dejo los .wav")

pistas_opus = [d / f"{p}.opus" for p, _ in PISTAS if (d / f"{p}.opus").exists()]
if len(pistas_opus) == 2:
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(pistas_opus[0]), "-i", str(pistas_opus[1]),
         "-filter_complex", "amix=inputs=2:normalize=0", "-c:a", "libopus", "-b:a", "32k",
         str(d / "reunion.opus")],
    )

with salida.open("a") as fh:
    fh.write(f"\nfin: {datetime.datetime.now():%Y-%m-%d %H:%M}\n")
(d / "LISTO").touch()
log("listo")

# Pasada final sobre el audio completo: los cortes cada SEG s parten palabras
# en la version en vivo; esta queda limpia en transcripcion_final.md.
log("pasada final con 8 hilos")
modelo = WhisperModel(MODELO, device="cpu", compute_type="int8", cpu_threads=8)
lineas = []
for p, etiqueta in PISTAS:
    audio = d / f"{p}.opus"
    if not audio.exists():
        continue
    segs, _ = modelo.transcribe(str(audio), language=IDIOMA, vad_filter=True, initial_prompt=CONTEXTO or None)
    for s in segs:
        texto = s.text.strip()
        if texto and s.no_speech_prob <= 0.6 and not ALUCINACION.search(texto):
            lineas.append((s.start, etiqueta, texto))
lineas.sort()
with (d / "transcripcion_final.md").open("w") as fh:
    fh.write(f"# Reunion {d.name} (final)\n\ninicio: {inicio:%Y-%m-%d %H:%M}\n\n")
    previa = None
    for t, etiqueta, texto in lineas:
        if (etiqueta, texto) == previa:
            continue  # whisper repite frases al final del audio
        previa = (etiqueta, texto)
        fh.write(f"[{inicio + datetime.timedelta(seconds=t):%H:%M:%S}] {etiqueta}: {texto}\n")
(d / "FINAL").touch()
log("final listo")
