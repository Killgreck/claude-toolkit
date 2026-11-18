import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CuentaConfig {
  nombre: string;
  dir: string;
  claudeJson: string;
  umbral?: number;
  etiqueta?: string;
}

export interface Config {
  puerto: number;
  evitarExtra: boolean;
  cuentas: CuentaConfig[];
}

const HOME = homedir();

export const DIR_CONFIG = process.env["RELEVO_CONFIG_DIR"] ?? join(HOME, ".config", "claude-relevo");
export const DIR_ESTADO = process.env["RELEVO_STATE_DIR"] ?? join(HOME, ".local", "state", "claude-relevo");
export const RUTA_CUENTAS = join(DIR_CONFIG, "cuentas.json");
export const RUTA_LLAVE = join(DIR_CONFIG, "llave");
export const RUTA_ESTADO = join(DIR_ESTADO, "estado.json");
export const RUTA_LOG = join(DIR_ESTADO, "relevo.log");
export const CLAUDE_BIN = process.env["RELEVO_CLAUDE_BIN"] ?? join(HOME, ".local", "bin", "claude");
export const DIR_CLAUDE_POR_DEFECTO = join(HOME, ".claude");

const CONFIG_INICIAL: Config = {
  puerto: 47800,
  evitarExtra: true,
  cuentas: [
    { nombre: "personal1", dir: join(HOME, ".claude"), claudeJson: join(HOME, ".claude.json") },
    {
      nombre: "empresa",
      dir: join(HOME, ".claude-empresa"),
      claudeJson: join(HOME, ".claude-empresa", ".claude.json"),
    },
    {
      nombre: "personal2",
      dir: join(HOME, ".claude-personal2"),
      claudeJson: join(HOME, ".claude-personal2", ".claude.json"),
    },
  ],
  // Para agregar otra cuenta: loguea el perfil (claude-cuentas login) y agrega una entrada
  // {"nombre","dir","claudeJson"} en el orden de prioridad que quieras. Un dir que aun no existe
  // cuenta como "muerta (sin login)" y se toma sola cuando aparezca su .credentials.json.
};

function asegurarDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignorar
  }
}

/** Crea cuentas.json y llave si faltan. No sobreescribe nada existente. */
export function inicializar(): void {
  asegurarDir(DIR_CONFIG);
  asegurarDir(DIR_ESTADO);
  if (!existsSync(RUTA_CUENTAS)) {
    writeFileSync(RUTA_CUENTAS, JSON.stringify(CONFIG_INICIAL, null, 2) + "\n", { mode: 0o600 });
  }
  if (!existsSync(RUTA_LLAVE)) {
    writeFileSync(RUTA_LLAVE, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
}

export function leerLlave(): string {
  return readFileSync(RUTA_LLAVE, "utf8").trim();
}

export function cargarConfig(): Config {
  const crudo: unknown = JSON.parse(readFileSync(RUTA_CUENTAS, "utf8"));
  if (typeof crudo !== "object" || crudo === null) throw new Error("cuentas.json invalido");
  const o = crudo as Record<string, unknown>;
  const lista = Array.isArray(o["cuentas"]) ? (o["cuentas"] as unknown[]) : [];
  const cuentas: CuentaConfig[] = [];
  for (const item of lista) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c["nombre"] !== "string" || typeof c["dir"] !== "string") continue;
    const claudeJson =
      typeof c["claudeJson"] === "string" ? c["claudeJson"] : join(c["dir"], ".claude.json");
    const cfg: CuentaConfig = { nombre: c["nombre"], dir: c["dir"], claudeJson };
    if (typeof c["umbral"] === "number") cfg.umbral = c["umbral"];
    if (typeof c["etiqueta"] === "string" && c["etiqueta"] !== "") cfg.etiqueta = c["etiqueta"];
    cuentas.push(cfg);
  }
  const puertoEnv = Number(process.env["RELEVO_PUERTO"]);
  const puerto =
    Number.isInteger(puertoEnv) && puertoEnv > 0
      ? puertoEnv
      : typeof o["puerto"] === "number"
        ? o["puerto"]
        : 47800;
  return {
    puerto,
    evitarExtra: o["evitarExtra"] !== false,
    cuentas,
  };
}
