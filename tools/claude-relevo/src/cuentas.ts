import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_BIN,
  DIR_CLAUDE_POR_DEFECTO,
  DIR_ESTADO,
  RUTA_ESTADO,
  type CuentaConfig,
} from "./config.ts";
import { horaCorta, log } from "./log.ts";

export type Marca = "" | "blanda" | "cupo" | "enfriando";
export type ResultadoRefresco = "cambio" | "sin-cambio" | "omitido";

export type EstadoCuenta = "lista" | "agotada" | "enfriando" | "muerta" | "duplicada";

export interface Cuenta {
  cfg: CuentaConfig;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms
  refreshTokenExpiresAt: number; // ms
  credMtime: number;
  accountUuid: string | null;
  correo: string | null;
  uuidMtime: number;
  muerta: boolean;
  muertaMtime: number;
  motivoMuerta: string;
  agotadaHasta: number; // epoch s, 0 = no
  marca: Marca; // blanda = umbral/evitarExtra; cupo = rechazo real; enfriando = pasajero o refresco fallido
  marcaTs: number; // ms: cuando se puso la marca vigente
  ultimoRefresco: number; // ms
  fallos401: number;
  uuidChecked: number; // ms
  uuidEstado: string | null; // accountUuid con el que se pusieron los datos de estado
  duplicadaDe: string | null;
  motivo: string;
  util5h: number | null;
  util7d: number | null;
  reset5h: number | null;
  reset7d: number | null;
  ultimoUso: number | null; // epoch s
  refrescando: Promise<ResultadoRefresco> | null;
}

const MARGEN_REFRESCO_MS = 5 * 60 * 1000;
const ESPERA_REFRESCO_MS = 60_000;
const SEIS_HORAS_MS = 6 * 60 * 60 * 1000;
const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

const VARS_A_QUITAR = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDECODE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const ahoraS = (): number => Math.floor(Date.now() / 1000);

export class Cuentas {
  readonly lista: Cuenta[];
  private ultimaActiva: string | null | undefined = undefined;
  private temporizador: NodeJS.Timeout | null = null;

  constructor(cfgs: CuentaConfig[]) {
    this.lista = cfgs.map((cfg) => ({
      cfg,
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      refreshTokenExpiresAt: 0,
      credMtime: -1,
      accountUuid: null,
      correo: null,
      uuidMtime: -1,
      muerta: false,
      muertaMtime: -1,
      motivoMuerta: "",
      agotadaHasta: 0,
      marca: "",
      marcaTs: 0,
      ultimoRefresco: 0,
      fallos401: 0,
      uuidChecked: 0,
      uuidEstado: null,
      duplicadaDe: null,
      motivo: "",
      util5h: null,
      util7d: null,
      reset5h: null,
      reset7d: null,
      ultimoUso: null,
      refrescando: null,
    }));
    this.restaurar();
    for (const c of this.lista) this.cargar(c);
    this.ultimaActiva = this.activa()?.cfg.nombre ?? null;
  }

  // ---------- persistencia ----------
  private restaurar(): void {
    let o: unknown;
    try {
      o = JSON.parse(readFileSync(RUTA_ESTADO, "utf8"));
    } catch {
      return; // sin estado previo
    }
    const cs = (typeof o === "object" && o !== null ? (o as { cuentas?: unknown }).cuentas : null) ?? {};
    if (typeof cs !== "object" || cs === null) {
      log("AVISO estado.json invalido: se descarta");
      return;
    }
    const ahora = Math.floor(Date.now() / 1000);
    for (const c of this.lista) {
      const e = (cs as Record<string, unknown>)[c.cfg.nombre];
      if (e === undefined) continue;
      if (typeof e !== "object" || e === null) {
        log(`AVISO estado.json: entrada de ${c.cfg.nombre} invalida, se descarta`);
        continue;
      }
      const r = e as Record<string, unknown>;
      const malos: string[] = [];
      const numero = (k: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined => {
        const v = r[k];
        if (v === undefined || v === null) return undefined;
        if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) return v;
        malos.push(k);
        return undefined;
      };
      const texto = (k: string): string | undefined => {
        const v = r[k];
        if (v === undefined || v === null) return undefined;
        if (typeof v === "string" && v.length < 300) return v;
        malos.push(k);
        return undefined;
      };
      const ah = numero("agotadaHasta", 0, ahora + 40 * 86400);
      const marca = texto("marca");
      if (marca !== undefined && !["", "blanda", "cupo", "enfriando"].includes(marca)) malos.push("marca");
      else if (marca !== undefined && ah !== undefined && ah > 0) {
        c.agotadaHasta = ah;
        c.marca = (marca === "" ? "cupo" : marca) as Marca;
        c.marcaTs = numero("marcaTs") ?? 0;
        c.motivo = texto("motivo") ?? "";
      }
      if (r["muerta"] === true) {
        c.muerta = true;
        c.muertaMtime = numero("muertaMtime", -10) ?? -1;
        c.motivoMuerta = texto("motivoMuerta") ?? "";
      } else if (r["muerta"] !== undefined && r["muerta"] !== false) malos.push("muerta");
      for (const k of ["util5h", "util7d"] as const) {
        const v = numero(k, 0, 100);
        if (v !== undefined) c[k] = v;
      }
      for (const k of ["reset5h", "reset7d", "ultimoUso"] as const) {
        const v = numero(k);
        if (v !== undefined) c[k] = v;
      }
      const u = texto("uuidEstado");
      if (u !== undefined) c.uuidEstado = u;
      if (malos.length) log(`AVISO estado.json: campos invalidos descartados en ${c.cfg.nombre}: ${malos.join(", ")}`);
    }
  }

  private persistir(): void {
    const cuentas: Record<string, unknown> = {};
    for (const c of this.lista) {
      cuentas[c.cfg.nombre] = {
        agotadaHasta: c.agotadaHasta,
        marca: c.marca,
        marcaTs: c.marcaTs,
        motivo: c.motivo,
        muerta: c.muerta,
        muertaMtime: c.muertaMtime,
        motivoMuerta: c.motivoMuerta,
        uuidEstado: c.uuidEstado,
        util5h: c.util5h,
        util7d: c.util7d,
        reset5h: c.reset5h,
        reset7d: c.reset7d,
        ultimoUso: c.ultimoUso,
      };
    }
    try {
      mkdirSync(DIR_ESTADO, { recursive: true, mode: 0o700 });
      const tmp = `${RUTA_ESTADO}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cuentas }, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, RUTA_ESTADO);
    } catch (e) {
      log(`WARNING no se pudo guardar estado.json: ${(e as Error).message}`);
    }
  }

  private diferido: NodeJS.Timeout | null = null;

  /** util/resets/ultimoUso: se guardan como mucho cada 30 s. */
  persistirDiferido(): void {
    if (this.diferido) return;
    const t = setTimeout(() => {
      this.diferido = null;
      this.persistir();
    }, 30_000);
    t.unref();
    this.diferido = t;
  }

  /** Guarda ya (al apagar). */
  vaciar(): void {
    if (this.diferido) clearTimeout(this.diferido);
    this.diferido = null;
    this.persistir();
  }

  /** Nombre para mostrar: etiqueta, o correo en vivo, o "perfil (sin login)". */
  nom(c: Cuenta): string {
    if (c.cfg.etiqueta) return c.cfg.etiqueta;
    if (c.credMtime > 0 && c.correo) return c.correo;
    return `${c.cfg.nombre} (sin login)`;
  }

  nomPerfil(perfil: string): string {
    const c = this.lista.find((x) => x.cfg.nombre === perfil);
    return c ? this.nom(c) : perfil;
  }

  // ---------- credenciales (solo lectura) ----------
  private rutaCred(c: Cuenta): string {
    return join(c.cfg.dir, ".credentials.json");
  }

  /** Relee credenciales si cambio el mtime y reevalua si esta muerta. */
  cargar(c: Cuenta, forzar = false): void {
    let mtime: number;
    try {
      mtime = statSync(this.rutaCred(c)).mtimeMs;
    } catch {
      this.marcarMuerta(c, "sin login", -2);
      this.actualizarDuplicadas();
      return;
    }
    if (forzar || mtime !== c.credMtime) {
      try {
        const o: unknown = JSON.parse(readFileSync(this.rutaCred(c), "utf8"));
        const oauth = (o as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth ?? {};
        c.accessToken = typeof oauth["accessToken"] === "string" ? oauth["accessToken"] : "";
        c.refreshToken = typeof oauth["refreshToken"] === "string" ? oauth["refreshToken"] : "";
        c.expiresAt = typeof oauth["expiresAt"] === "number" ? oauth["expiresAt"] : 0;
        c.refreshTokenExpiresAt =
          typeof oauth["refreshTokenExpiresAt"] === "number" ? oauth["refreshTokenExpiresAt"] : 0;
      } catch {
        // archivo a medio escribir: se reintenta en la proxima lectura
        c.credMtime = -1;
        return;
      }
      c.credMtime = mtime;
      c.uuidChecked = 0; // credenciales nuevas: relee el uuid ya, sin cache de 60 s
    }
    this.leerUuid(c);
    if (c.muerta && c.muertaMtime !== mtime) {
      c.muerta = false;
      c.motivoMuerta = "";
      log(`cuenta=${this.nom(c)} credenciales cambiaron: se reevalua`);
      this.persistir();
    }
    if (!c.muerta) {
      if (!c.refreshToken) this.marcarMuerta(c, "sin refreshToken", mtime);
      else if (c.refreshTokenExpiresAt > 0 && c.refreshTokenExpiresAt < Date.now())
        this.marcarMuerta(c, "refreshToken vencido", mtime);
    }
    this.actualizarDuplicadas();
  }

  /** Marca `duplicada` a la cuenta de menor prioridad que comparte accountUuid. Loguea solo al cambiar. */
  private actualizarDuplicadas(): void {
    for (let i = 0; i < this.lista.length; i++) {
      const c = this.lista[i] as Cuenta;
      let de: string | null = null;
      if (c.accountUuid) {
        for (let k = 0; k < i; k++) {
          const o = this.lista[k] as Cuenta;
          if (o.accountUuid === c.accountUuid) {
            de = o.cfg.nombre;
            break;
          }
        }
      }
      if (de !== c.duplicadaDe) {
        c.duplicadaDe = de;
        log(de ? `cuenta=${this.nom(c)} DUPLICADA (misma cuenta que ${this.nomPerfil(de)}); fuera de la rotacion y sin refresco` : `cuenta=${this.nom(c)} ya no es duplicada`);
      }
    }
  }

  private reiniciarEstado(c: Cuenta): void {
    c.agotadaHasta = 0;
    c.marca = "";
    c.marcaTs = 0;
    c.motivo = "";
    c.fallos401 = 0;
    c.util5h = c.util7d = c.reset5h = c.reset7d = c.ultimoUso = null;
    c.muerta = false;
    c.muertaMtime = -1;
    c.motivoMuerta = "";
    c.ultimoRefresco = 0;
  }

  private leerUuid(c: Cuenta): void {
    const ahora = Date.now();
    if (c.uuidChecked > 0 && ahora - c.uuidChecked < 60_000) return;
    c.uuidChecked = ahora;
    try {
      const m = statSync(c.cfg.claudeJson).mtimeMs;
      if (m === c.uuidMtime) return;
      const o: unknown = JSON.parse(readFileSync(c.cfg.claudeJson, "utf8"));
      const u = (o as { oauthAccount?: { accountUuid?: unknown } }).oauthAccount?.accountUuid;
      c.accountUuid = typeof u === "string" ? u : null;
      const mail = (o as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
      c.correo = typeof mail === "string" && mail !== "" ? mail : null;
      c.uuidMtime = m;
      if (c.accountUuid) {
        if (c.uuidEstado !== null && c.uuidEstado !== c.accountUuid) {
          log(`${this.nom(c)} cambio de cuenta (el perfil ahora es otra cuenta): se reinicia su estado`);
          this.reiniciarEstado(c);
          this.persistir();
        }
        if (c.uuidEstado !== c.accountUuid) {
          c.uuidEstado = c.accountUuid;
          this.persistir();
        }
      }
    } catch {
      // se queda con el valor anterior
    }
  }

  // ---------- estados ----------
  marcarMuerta(c: Cuenta, motivo: string, mtime: number = c.credMtime): void {
    if (c.muerta && c.muertaMtime === mtime) return;
    c.muerta = true;
    c.muertaMtime = mtime;
    c.motivoMuerta = motivo;
    log(`cuenta=${this.nom(c)} MUERTA (${motivo}); no se ejecuta claude sobre ella`);
    this.persistir();
  }

  marcarEnfriando(c: Cuenta, hastaS: number, motivo: string): void {
    c.agotadaHasta = hastaS;
    c.marca = "enfriando";
    c.marcaTs = Date.now();
    c.motivo = motivo;
    log(`cuenta=${this.nom(c)} ENFRIANDO (${motivo}) hasta ${horaCorta(hastaS)}`);
    this.persistir();
  }

  marcarAgotada(c: Cuenta, hastaS: number, motivo: string, blanda = false): void {
    c.agotadaHasta = hastaS;
    c.marca = blanda ? "blanda" : "cupo";
    c.marcaTs = Date.now();
    c.motivo = motivo;
    log(`cuenta=${this.nom(c)} AGOTADA (${motivo}) hasta ${horaCorta(hastaS)}`);
    this.persistir();
  }

  estadoDe(c: Cuenta): EstadoCuenta {
    if (c.duplicadaDe) return "duplicada";
    if (c.muerta) return "muerta";
    if (c.agotadaHasta > 0) {
      if (c.agotadaHasta <= ahoraS()) {
        c.agotadaHasta = 0;
        c.marca = "";
        c.motivo = "";
        this.persistir();
      } else return c.marca === "enfriando" ? "enfriando" : "agotada";
    }
    return "lista";
  }

  disponible(c: Cuenta): boolean {
    this.cargar(c);
    return this.estadoDe(c) === "lista";
  }

  /** Reevalua TODAS las cuentas por existencia/mtime (activa() se detiene en la primera lista). */
  recargarTodas(): void {
    for (const c of this.lista) this.cargar(c);
  }

  activa(excluir?: ReadonlySet<Cuenta>): Cuenta | null {
    if (!excluir || excluir.size === 0) this.recargarTodas();
    for (const c of this.lista) {
      if (excluir?.has(c)) continue;
      if (this.disponible(c)) return c;
    }
    return null;
  }

  /**
   * Ultimo recurso cuando no hay ninguna lista: todas las no muertas, en orden:
   * (a) marcas blandas (umbral/evitarExtra) por prioridad, (b) enfriando por reset, (c) cupo por reset.
   */
  ultimoRecurso(excluir?: ReadonlySet<Cuenta>): Cuenta | null {
    const orden: Marca[] = ["blanda", "enfriando", "cupo"];
    const cand = this.lista.filter((c) => !excluir?.has(c) && !c.muerta && !c.duplicadaDe && this.estadoDe(c) !== "lista");
    for (const m of orden) {
      const grupo = cand.filter((c) => c.marca === m);
      if (grupo.length === 0) continue;
      if (m !== "blanda") grupo.sort((a, b) => a.agotadaHasta - b.agotadaHasta);
      return grupo[0] ?? null;
    }
    return null;
  }

  todasMuertas(): boolean {
    return this.lista.every((c) => {
      this.cargar(c);
      return c.muerta || c.duplicadaDe !== null;
    });
  }

  /** Backoff tras un 401 sin refresco efectivo: 2, 5, 15, tope 30 min. */
  enfriar401(c: Cuenta): void {
    const pasos = [120, 300, 900, 1800];
    const seg = pasos[Math.min(c.fallos401, pasos.length - 1)] ?? 1800;
    c.fallos401++;
    this.marcarEnfriando(c, ahoraS() + seg, `401 sin refresco efectivo (reintento en ${Math.round(seg / 60)} min)`);
  }

  /** Un exito prueba que la cuenta sirve, pero solo borra marcas puestas ANTES de que saliera esa peticion. */
  limpiarAgotada(c: Cuenta, desdeMs: number): void {
    c.fallos401 = 0;
    if (c.agotadaHasta === 0 || c.marcaTs >= desdeMs) return;
    log(`cuenta=${this.nom(c)} respondio bien estando marcada agotada: se limpia la marca`);
    c.agotadaHasta = 0;
    c.marca = "";
    c.motivo = "";
    this.persistir();
  }

  /** Detecta cambio de cuenta activa; devuelve texto para el log o null. */
  revisarCambio(): string | null {
    const nueva = this.activa();
    const nombre = nueva?.cfg.nombre ?? null;
    if (nombre === this.ultimaActiva) return null;
    const prev = this.lista.find((c) => c.cfg.nombre === this.ultimaActiva);
    this.ultimaActiva = nombre;
    let msg: string;
    const destino = nueva ? this.nom(nueva) : "ninguna disponible";
    if (prev && prev.muerta) msg = `${this.nom(prev)} muerta (${prev.motivoMuerta}) -> ${destino}`;
    else if (prev && prev.marca === "enfriando") {
      // 429 pasajero: no es cambio por cupo, solo log
      log(`CAMBIO ${this.nom(prev)} enfriando (${prev.motivo}) -> ${destino}`);
      return null;
    } else if (prev && prev.agotadaHasta > 0)
      msg = `${this.nom(prev)} agotada (${prev.motivo}, vuelve ${horaCorta(prev.agotadaHasta)}) -> ${destino}`;
    else msg = `activa ahora: ${destino}`;
    log(`CAMBIO ${msg}`);
    this.notificar(msg);
    return msg;
  }

  private notificar(msg: string): void {
    if (process.env["RELEVO_SIN_NOTIFY"] === "1") return;
    try {
      const p = spawn("notify-send", ["Claude relevo", msg], { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
    } catch {
      // ignorar
    }
  }

  // ---------- refresco via claude local ----------
  private ejecutarClaude(c: Cuenta): Promise<void> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of VARS_A_QUITAR) delete env[k];
      if (c.cfg.dir !== DIR_CLAUDE_POR_DEFECTO) env["CLAUDE_CONFIG_DIR"] = c.cfg.dir;
      log(`cuenta=${this.nom(c)} refresco: ejecutando claude -p /usage`);
      const cwd = existsSync(DIR_ESTADO) ? DIR_ESTADO : undefined;
      execFile(
        CLAUDE_BIN,
        ["-p", "/usage", "--output-format", "json", "--no-session-persistence"],
        { env, cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (err) => {
          if (err) log(`cuenta=${this.nom(c)} refresco: claude termino con error (${err.message.split("\n")[0]})`);
          resolve();
        },
      );
    });
  }

  /** Single-flight por cuenta, con espera minima de 60 s entre intentos. Nunca corre sobre cuentas muertas. */
  refrescar(c: Cuenta): Promise<ResultadoRefresco> {
    if (c.refrescando) return c.refrescando;
    this.cargar(c);
    if (c.muerta || c.duplicadaDe || !c.refreshToken) return Promise.resolve("omitido");
    if (Date.now() - c.ultimoRefresco < ESPERA_REFRESCO_MS) return Promise.resolve("omitido");
    c.ultimoRefresco = Date.now();
    const antes = c.accessToken;
    const p = this.ejecutarClaude(c).then((): ResultadoRefresco => {
      this.cargar(c, true);
      return c.accessToken !== "" && c.accessToken !== antes ? "cambio" : "sin-cambio";
    });
    c.refrescando = p.finally(() => {
      c.refrescando = null;
    });
    return c.refrescando;
  }

  /**
   * Devuelve el accessToken a usar. Si vence en < 5 min intenta refrescar; si el refresco no sirve y
   * el token aun no vencio lo usa; si ya vencio la cuenta pasa a enfriando (null).
   */
  async tokenListo(c: Cuenta): Promise<string | null> {
    this.cargar(c);
    if (c.muerta || c.duplicadaDe) return null;
    const porVencer = !c.accessToken || (c.expiresAt > 0 && c.expiresAt - Date.now() < MARGEN_REFRESCO_MS);
    if (porVencer) {
      await this.refrescar(c);
      if (c.muerta) return null;
      if (!c.accessToken || (c.expiresAt > 0 && c.expiresAt <= Date.now())) {
        this.marcarEnfriando(c, ahoraS() + 60, "token vencido y el refresco no lo renovo");
        return null;
      }
    }
    return c.accessToken;
  }

  // ---------- mantener vivas ----------
  async mantenerVivas(): Promise<void> {
    for (const c of this.lista) {
      this.cargar(c);
      if (c.muerta || c.duplicadaDe) continue;
      if (c.refreshTokenExpiresAt - Date.now() < SIETE_DIAS_MS) {
        log(`cuenta=${this.nom(c)} mantener viva: refreshToken vence pronto`);
        await this.refrescar(c);
      }
    }
  }

  iniciarMantenimiento(): void {
    const t = setInterval(() => void this.mantenerVivas(), SEIS_HORAS_MS);
    t.unref();
    this.temporizador = t;
    const inicial = setTimeout(() => void this.mantenerVivas(), 15_000);
    inicial.unref();
  }

  detener(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    this.vaciar();
  }

  // ---------- vista publica (sin tokens) ----------
  vista(): unknown {
    this.recargarTodas();
    const act = this.activa();
    return {
      activa: act ? this.nom(act) : null,
      activaPerfil: act?.cfg.nombre ?? null,
      cuentas: this.lista.map((c) => ({
        nombre: c.cfg.nombre,
        correo: this.nom(c),
        estado: this.estadoDe(c),
        agotadaHasta: c.agotadaHasta || null,
        motivo: c.duplicadaDe ? `misma cuenta que ${this.nomPerfil(c.duplicadaDe)}` : c.muerta ? c.motivoMuerta : c.motivo || null,
        util5h: c.util5h,
        util7d: c.util7d,
        reset5h: c.reset5h,
        reset7d: c.reset7d,
        refreshTokenExpiresAt: c.refreshTokenExpiresAt || null,
        ultimoUso: c.ultimoUso,
      })),
    };
  }
}
