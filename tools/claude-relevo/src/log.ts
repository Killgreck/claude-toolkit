import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { DIR_ESTADO, RUTA_LOG } from "./config.ts";

const MAX_LOG = 5 * 1024 * 1024;
let tam = -1;

function dosDig(n: number): string {
  return String(n).padStart(2, "0");
}

export function horaLocal(ms: number = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())} ${dosDig(d.getHours())}:${dosDig(d.getMinutes())}:${dosDig(d.getSeconds())}`;
}

export function horaCorta(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`;
}

/** Una linea al log (600 al crearlo, rota a relevo.log.1 sobre 5 MB). Nunca pasar tokens ni bodies. */
export function log(linea: string): void {
  const texto = `${horaLocal()} ${linea}\n`;
  try {
    mkdirSync(DIR_ESTADO, { recursive: true, mode: 0o700 });
    if (tam < 0) {
      try {
        tam = statSync(RUTA_LOG).size;
      } catch {
        tam = 0;
      }
    }
    if (tam > MAX_LOG) {
      renameSync(RUTA_LOG, RUTA_LOG + ".1");
      tam = 0;
    }
    appendFileSync(RUTA_LOG, texto, { mode: 0o600 });
    tam += Buffer.byteLength(texto);
  } catch {
    // el log nunca debe tumbar el proxy
  }
  if (process.env["RELEVO_LOG_STDERR"] === "1") process.stderr.write(texto);
}
