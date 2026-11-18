import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cargarConfig, inicializar, leerLlave, RUTA_LOG } from "./config.ts";
import { horaLocal } from "./log.ts";

interface Fila {
  nombre: string;
  correo: string;
  estado: string;
  agotadaHasta: number | null;
  motivo: string | null;
  util5h: number | null;
  util7d: number | null;
  reset5h: number | null;
  reset7d: number | null;
  refreshTokenExpiresAt: number | null;
  ultimoUso: number | null;
}

const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
const hora = (s: number | null): string => (s === null ? "-" : horaLocal(s * 1000).slice(5, 16));
const dia = (ms: number | null): string => (ms === null ? "-" : horaLocal(ms).slice(0, 10));

async function estado(): Promise<void> {
  const cfg = cargarConfig();
  let datos: { activa: string | null; cuentas: Fila[] };
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.puerto}/__relevo/estado`, {
      headers: { "x-relevo-llave": leerLlave() },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    datos = (await r.json()) as typeof datos;
  } catch (e) {
    process.stderr.write(`claude-relevo: el servidor no responde en el puerto ${cfg.puerto} (${(e as Error).message})\n`);
    process.exit(1);
  }
  console.log(`Cuenta activa: ${datos.activa ?? "ninguna"}\n`);
  const cab = ["CUENTA", "ESTADO", "VUELVE", "5h", "7d", "RESET 5h", "RESET 7d", "TOKEN VENCE", "ULTIMO USO", "MOTIVO", "PERFIL"];
  const filas = datos.cuentas.map((c) => [
    c.correo,
    c.estado,
    hora(c.agotadaHasta),
    pct(c.util5h),
    pct(c.util7d),
    hora(c.reset5h),
    hora(c.reset7d),
    dia(c.refreshTokenExpiresAt),
    hora(c.ultimoUso),
    c.motivo ?? "",
    c.nombre,
  ]);
  const anchos = cab.map((t, i) => Math.max(t.length, ...filas.map((f) => (f[i] ?? "").length)));
  const fmt = (f: string[]): string => f.map((x, i) => x.padEnd(anchos[i] ?? 0)).join("  ").trimEnd();
  console.log(fmt(cab));
  for (const f of filas) console.log(fmt(f));
}

function verLog(): void {
  if (!existsSync(RUTA_LOG)) {
    console.error(`No hay log todavia en ${RUTA_LOG}`);
    process.exit(1);
  }
  const seguir = process.argv.includes("-f");
  const r = spawnSync("tail", [...(seguir ? ["-f"] : []), "-n", "40", RUTA_LOG], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

const sub = process.argv[2];
if (sub === "estado") await estado();
else if (sub === "log") verLog();
else if (sub === "init") {
  inicializar();
  console.log("config e llave listas");
  console.log(
    "Para agregar una cuenta: claude-cuentas login <nombre>, y agrega en cuentas.json una entrada\n" +
      '{"nombre":"...","dir":"__HOME__/.claude-X","claudeJson":"__HOME__/.claude-X/.claude.json"}\n' +
      'en el orden de prioridad que quieras (opcional "umbral"). Si el dir aun no existe cuenta como\n' +
      "muerta (sin login) y se toma sola cuando aparezca su .credentials.json.",
  );
} else {
  console.error("Uso: claude-relevo estado | log [-f] | servidor | init");
  process.exit(sub ? 2 : 0);
}
