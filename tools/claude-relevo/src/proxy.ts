import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { Cuenta, Cuentas } from "./cuentas.ts";
import { log } from "./log.ts";

const UPSTREAM = new URL(process.env["RELEVO_UPSTREAM"] ?? "https://api.anthropic.com");
const ES_HTTPS = UPSTREAM.protocol === "https:";
const AGENTE_HTTPS = new https.Agent({ keepAlive: true });
const AGENTE_HTTP = new http.Agent({ keepAlive: true });

const HOP_POR_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "x-relevo-llave",
]);
const MAX_BODY_RECHAZO = 1024 * 1024;

export const AVISO_UPSTREAM = process.env["RELEVO_UPSTREAM"]
  ? `WARNING RELEVO_UPSTREAM activo: las peticiones van a ${UPSTREAM.origin} (SIMULACRO, no es Anthropic)`
  : null;

interface Limites {
  status: string | undefined;
  reset: number | undefined;
  util5h: number | undefined;
  util7d: number | undefined;
  reset5h: number | undefined;
  reset7d: number | undefined;
  hayUnified: boolean;
  overageStatus: string | undefined;
  overageInUse: boolean;
  overageReset: number | undefined;
}

interface RespuestaBuf {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  resetS: number;
}

function h1(h: IncomingHttpHeaders, k: string): string | undefined {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function leerLimites(h: IncomingHttpHeaders): Limites {
  const p = "anthropic-ratelimit-unified-";
  return {
    status: h1(h, p + "status"),
    reset: num(h1(h, p + "reset")),
    util5h: num(h1(h, p + "5h-utilization")),
    util7d: num(h1(h, p + "7d-utilization")),
    reset5h: num(h1(h, p + "5h-reset")),
    reset7d: num(h1(h, p + "7d-reset")),
    hayUnified: Object.keys(h).some((k) => k.startsWith(p)),
    overageStatus: h1(h, p + "overage-status"),
    overageInUse: h1(h, p + "overage-in-use") === "true",
    overageReset: num(h1(h, p + "overage-reset")),
  };
}

/** Logica de Claude Code: rejected y (overage ausente o rejected). */
export function clasificar(status: number, l: Limites): "cupo" | "pasajero" | null {
  if (l.status === "rejected" && (l.overageStatus === undefined || l.overageStatus === "rejected")) return "cupo";
  if (status !== 429) return null;
  // 429 con headers unified que no dicen "allowed" tambien es cupo; sin ellos es estrangulamiento pasajero
  if (l.hayUnified && l.status !== "allowed") return "cupo";
  return "pasajero";
}

export function resetDe(h: IncomingHttpHeaders, l: Limites): number {
  const ahora = Math.floor(Date.now() / 1000);
  if (l.reset !== undefined && l.reset > ahora) return Math.floor(l.reset);
  const ra = num(h1(h, "retry-after"));
  if (ra !== undefined) return ahora + Math.max(1, Math.ceil(ra));
  return ahora + 3600;
}

function llaveValida(recibida: string | string[] | undefined, llave: string): boolean {
  const r = Array.isArray(recibida) ? recibida[0] : recibida;
  if (!r) return false;
  const a = Buffer.from(r);
  const b = Buffer.from(llave);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cabecerasSalida(entrada: IncomingHttpHeaders, extra: Record<string, string>): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(entrada)) {
    if (HOP_POR_HOP.has(k) || v === undefined) continue;
    out[k] = v;
  }
  out["host"] = UPSTREAM.host;
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

class ClienteCorto extends Error {}

function leerBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    req.on("data", (d: Buffer) => partes.push(d));
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", () => reject(new ClienteCorto("cliente corto durante la subida")));
    req.on("close", () => {
      if (!req.complete) reject(new ClienteCorto("cliente corto durante la subida"));
    });
  });
}

function leerRespuestaCompleta(up: IncomingMessage, limite: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const partes: Buffer[] = [];
    let total = 0;
    up.on("data", (d: Buffer) => {
      if (total < limite) partes.push(d);
      total += d.length;
    });
    up.on("end", () => resolve(Buffer.concat(partes)));
    up.on("error", () => resolve(Buffer.concat(partes)));
    up.on("close", () => resolve(Buffer.concat(partes)));
  });
}

function escapeRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cambia account_uuid dentro de metadata.user_id con un reemplazo quirurgico en el texto crudo:
 * solo se toca la subcadena `"user_id":<json del valor viejo>`, y solo si aparece EXACTAMENTE una vez.
 * Si no, el body va intacto y se devuelve un aviso.
 */
export function reescribirBody(body: Buffer, uuid: string | null): { body: Buffer; aviso: string | null } {
  if (!uuid || body.length === 0) return { body, aviso: null };
  let viejo: string;
  let nuevo: string;
  try {
    const o: unknown = JSON.parse(body.toString("utf8"));
    if (typeof o !== "object" || o === null) return { body, aviso: null };
    const md = (o as { metadata?: { user_id?: unknown } }).metadata;
    if (!md || typeof md.user_id !== "string") return { body, aviso: null };
    viejo = md.user_id;
    const interno: unknown = JSON.parse(viejo);
    if (typeof interno !== "object" || interno === null || !("account_uuid" in interno)) return { body, aviso: null };
    const i = interno as { account_uuid: unknown };
    if (i.account_uuid === uuid) return { body, aviso: null };
    const anterior = JSON.stringify(i.account_uuid);
    const buscado = `"account_uuid":${anterior}`;
    nuevo =
      viejo.split(buscado).length === 2
        ? viejo.replace(buscado, () => `"account_uuid":${JSON.stringify(uuid)}`)
        : JSON.stringify({ ...interno, account_uuid: uuid });
  } catch {
    return { body, aviso: null };
  }
  const texto = body.toString("utf8");
  const re = new RegExp(`("user_id"\\s*:\\s*)${escapeRegex(JSON.stringify(viejo))}`, "g");
  const aciertos = [...texto.matchAll(re)];
  const uno = aciertos[0];
  if (aciertos.length !== 1 || !uno || uno.index === undefined) {
    return { body, aviso: `AVISO no se reescribio account_uuid: el user_id aparece ${aciertos.length} veces en el body crudo (se envia intacto)` };
  }
  const fin = uno.index + uno[0].length;
  const salida = texto.slice(0, uno.index) + uno[1] + JSON.stringify(nuevo) + texto.slice(fin);
  return { body: Buffer.from(salida, "utf8"), aviso: null };
}

function enviarUpstream(
  metodo: string,
  rutaYQuery: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
  registrar: (r: http.ClientRequest) => void,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || (ES_HTTPS ? 443 : 80),
      method: metodo,
      path: rutaYQuery,
      headers,
      agent: ES_HTTPS ? AGENTE_HTTPS : AGENTE_HTTP,
    };
    const r = (ES_HTTPS ? https : http).request(opts, resolve);
    registrar(r);
    r.on("error", reject);
    r.end(body);
  });
}

function jsonError(res: ServerResponse, status: number, tipo: string, msg: string): void {
  const cuerpo = JSON.stringify({ type: "error", error: { type: tipo, message: msg } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

function enviarBuffer(res: ServerResponse, r: RespuestaBuf): void {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(r.headers)) {
    if (v === undefined || k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
    h[k] = v;
  }
  h["content-length"] = r.body.length;
  res.writeHead(r.status, h);
  res.end(r.body);
}

function pasarStreaming(up: IncomingMessage, res: ServerResponse): void {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(up.headers)) {
    if (v === undefined || k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
    h[k] = v;
  }
  res.writeHead(up.statusCode ?? 502, h);
  up.on("error", () => res.destroy());
  up.pipe(res);
}

/** Solo el campo error.type del body (nunca el contenido), para diagnosticar. */
function tipoError(body: Buffer): string {
  try {
    const t = (JSON.parse(body.toString("utf8")) as { error?: { type?: unknown } }).error?.type;
    return typeof t === "string" ? t.slice(0, 40) : "-";
  } catch {
    return "-";
  }
}

function descError(e: unknown): string {
  const x = e as NodeJS.ErrnoException & { errors?: (NodeJS.ErrnoException & { address?: string })[] };
  const partes = [x.code, x.message, ...(x.errors ?? []).map((i) => `${i.code ?? ""} ${i.address ?? ""}`)];
  return partes.filter(Boolean).join(" | ") || String(e);
}

const f2 = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : n.toFixed(2));

export function crearServidor(cfg: Config, cuentas: Cuentas, llave: string): http.Server {
  async function manejarMensajes(req: IncomingMessage, res: ServerResponse, rutaYQuery: string, ruta: string): Promise<void> {
    const inicio = Date.now();
    let body: Buffer;
    try {
      body = await leerBody(req);
    } catch (e) {
      if (e instanceof ClienteCorto) {
        log(`${req.method} ${ruta} cliente corto durante la subida del body`);
        return;
      }
      throw e;
    }
    // sin cuentas vivas: pasa como si no hubiera proxy (Authorization original, body intacto)
    if (cuentas.todasMuertas()) {
      log(`${req.method} ${ruta} sin cuentas vivas: se reenvia con el Authorization original`);
      await reenviarTal(req, res, rutaYQuery, ruta, body);
      return;
    }
    let cortado = false;
    let upstreamActual: http.ClientRequest | null = null;
    res.on("close", () => {
      if (!res.writableFinished) {
        cortado = true;
        upstreamActual?.destroy();
      }
    });
    const registrar = (r: http.ClientRequest): void => {
      upstreamActual = r;
    };

    const probadas = new Set<Cuenta>();
    const rechazos: RespuestaBuf[] = [];
    let ultimo401: RespuestaBuf | null = null;
    const notas: string[] = [];

    for (;;) {
      if (cortado) return;
      // primero las listas; si no hay ninguna, todas las demas no muertas (blandas, enfriando, cupo)
      const c = cuentas.activa(probadas) ?? cuentas.ultimoRecurso(probadas);
      if (!c) break;
      probadas.add(c);
      let reintento401 = false;
      for (;;) {
        const token = await cuentas.tokenListo(c);
        if (cortado) return;
        if (!token) {
          const cam = cuentas.revisarCambio();
          if (cam) notas.push(cam);
          break;
        }
        const r = reescribirBody(body, c.accountUuid);
        if (r.aviso) log(`POST ${ruta} cuenta=${cuentas.nom(c)} ${r.aviso}`);
        const cuerpo = r.body;
        const extra: Record<string, string> = {
          authorization: `Bearer ${token}`,
          "content-length": String(cuerpo.length),
        };
        let up: IncomingMessage;
        try {
          const enviar = (): Promise<IncomingMessage> =>
            enviarUpstream(req.method ?? "POST", rutaYQuery, cabecerasSalida(req.headers, extra), cuerpo, registrar);
          try {
            up = await enviar();
          } catch (e1) {
            if (cortado) return;
            log(`POST ${ruta} cuenta=${cuentas.nom(c)} fallo de conexion upstream (${descError(e1)}); reintento una vez`);
            up = await enviar();
          }
        } catch (e) {
          if (cortado) return;
          log(`POST ${ruta} cuenta=${cuentas.nom(c)} ERROR upstream: ${descError(e)}`);
          jsonError(res, 502, "api_error", `claude-relevo: no se pudo contactar a ${UPSTREAM.host}`);
          return;
        }
        const status = up.statusCode ?? 502;
        const lim = leerLimites(up.headers);
        const ms = Date.now() - inicio;
        const linea = (extraTxt: string): void =>
          log(
            `${req.method} ${ruta} cuenta=${cuentas.nom(c)} status=${status} util5h=${f2(lim.util5h)} util7d=${f2(lim.util7d)} ms=${ms}${extraTxt}${notas.length ? " cambios=[" + notas.join("; ") + "]" : ""}`,
          );

        const clase = clasificar(status, lim);
        if (clase === "pasajero") {
          const buf = await leerRespuestaCompleta(up, MAX_BODY_RECHAZO);
          const ra = num(h1(up.headers, "retry-after"));
          const enfria = ra !== undefined ? Math.min(300, Math.max(1, Math.ceil(ra))) : 60;
          const hasta = Math.floor(Date.now() / 1000) + enfria;
          rechazos.push({ status, headers: up.headers, body: buf, resetS: hasta });
          cuentas.marcarEnfriando(c, hasta, "429 pasajero");
          const cam = cuentas.revisarCambio();
          if (cam) notas.push(cam);
          linea(` 429 pasajero tipo=${tipoError(buf)} enfria=${enfria}s`);
          break;
        }
        if (clase === "cupo") {
          const buf = await leerRespuestaCompleta(up, MAX_BODY_RECHAZO);
          const resetS = resetDe(up.headers, lim);
          rechazos.push({ status, headers: up.headers, body: buf, resetS });
          actualizarLimites(c, lim);
          cuentas.marcarAgotada(c, resetS, motivoRechazo(up.headers, status));
          const cam = cuentas.revisarCambio();
          if (cam) notas.push(cam);
          linea(` rechazo tipo=${tipoError(buf)} retry-after=${h1(up.headers, "retry-after") ?? "-"}`);
          break;
        }
        if (status === 401) {
          const buf = await leerRespuestaCompleta(up, MAX_BODY_RECHAZO);
          ultimo401 = { status, headers: up.headers, body: buf, resetS: 0 };
          if (!reintento401) {
            reintento401 = true;
            cuentas.cargar(c);
            // el archivo pudo rotar solo (Claude Code); si no, se pide el refresco
            let cambio = !c.muerta && c.accessToken !== "" && c.accessToken !== token;
            if (!cambio && !c.muerta) cambio = (await cuentas.refrescar(c)) === "cambio";
            if (cortado) return;
            if (cambio && !c.muerta) {
              linea(" 401 -> token renovado, reintento");
              continue;
            }
            if (!c.muerta) cuentas.enfriar401(c);
            linea(c.muerta ? " 401 -> cuenta muerta" : " 401 sin refresco efectivo -> enfriando");
          } else {
            cuentas.marcarMuerta(c, "401 con token renovado");
            linea(" 401 tras token renovado -> muerta");
          }
          const cam = cuentas.revisarCambio();
          if (cam) notas.push(cam);
          break;
        }

        // pasa tal cual (200, 5xx, 4xx, etc.)
        if (status >= 200 && status < 300) {
          actualizarLimites(c, lim);
          cuentas.limpiarAgotada(c, inicio);
          c.ultimoUso = Math.floor(Date.now() / 1000);
          aplicarPoliticas(c, lim);
          cuentas.persistirDiferido();
          const cam = cuentas.revisarCambio();
          if (cam) notas.push(cam);
        }
        linea("");
        pasarStreaming(up, res);
        return;
      }
    }

    // ninguna cuenta pudo servir
    if (cortado) return;
    if (rechazos.length > 0) {
      rechazos.sort((a, b) => a.resetS - b.resetS);
      const r = rechazos[0];
      if (r) {
        log(`POST ${ruta} sin cuentas con cupo: se devuelve el 429 con reset mas cercano`);
        enviarBuffer(res, r);
        return;
      }
    }
    if (ultimo401) {
      log(`POST ${ruta} ninguna cuenta sirvio: se devuelve el ultimo 401`);
      enviarBuffer(res, ultimo401);
      return;
    }
    if (cuentas.todasMuertas()) {
      log(`POST ${ruta} todas las cuentas muertas: se reenvia con el Authorization original`);
      await reenviarTal(req, res, rutaYQuery, ruta, body);
      return;
    }
    log(`POST ${ruta} cuentas en enfriamiento sin respuesta: 503`);
    jsonError(res, 503, "api_error", "claude-relevo: cuentas en enfriamiento (refresco fallido); reintenta en un momento");
  }

  function motivoRechazo(h: IncomingHttpHeaders, status: number): string {
    const cl = h1(h, "anthropic-ratelimit-unified-representative-claim");
    const corto = cl === "five_hour" ? "5h" : cl === "seven_day" ? "7d" : (cl ?? "");
    return corto ? `${corto}, http ${status}` : `http ${status}`;
  }

  function actualizarLimites(c: Cuenta, l: Limites): void {
    if (l.util5h !== undefined) c.util5h = l.util5h;
    if (l.util7d !== undefined) c.util7d = l.util7d;
    if (l.reset5h !== undefined) c.reset5h = l.reset5h;
    if (l.reset7d !== undefined) c.reset7d = l.reset7d;
    cuentas.persistirDiferido();
  }

  /** umbral y evitarExtra: aplican desde la siguiente peticion. */
  function aplicarPoliticas(c: Cuenta, l: Limites): void {
    const umbral = c.cfg.umbral ?? 1;
    const ahora = Math.floor(Date.now() / 1000);
    if (umbral < 1) {
      let hasta = 0;
      let cual = "";
      if (l.util5h !== undefined && l.util5h >= umbral) {
        hasta = Math.max(hasta, l.reset5h ?? ahora + 3600);
        cual = "5h";
      }
      if (l.util7d !== undefined && l.util7d >= umbral) {
        const r = l.reset7d ?? ahora + 3600;
        if (r >= hasta) cual = cual ? cual + "+7d" : "7d";
        hasta = Math.max(hasta, r);
      }
      if (hasta > ahora) {
        cuentas.marcarAgotada(c, hasta, `umbral ${umbral} (${cual})`, true);
        return;
      }
    }
    if (cfg.evitarExtra) {
      const llena5 = l.util5h !== undefined && l.util5h >= 1;
      const llena7 = l.util7d !== undefined && l.util7d >= 1;
      if ((l.overageInUse || llena5 || llena7) && cuentas.lista.some((o) => o !== c && cuentas.disponible(o))) {
        const hasta = Math.max(
          l.overageReset ?? 0,
          llena5 ? (l.reset5h ?? 0) : 0,
          llena7 ? (l.reset7d ?? 0) : 0,
          l.reset ?? 0,
        );
        cuentas.marcarAgotada(c, hasta > ahora ? hasta : ahora + 3600, "evitar uso extra", true);
      }
    }
  }

  /** Reenvia tal cual (Authorization y body originales), solo quitando la llave. */
  async function reenviarTal(req: IncomingMessage, res: ServerResponse, rutaYQuery: string, ruta: string, body: Buffer): Promise<void> {
    const extra: Record<string, string> = {};
    if (body.length > 0 || (req.method !== "GET" && req.method !== "HEAD")) extra["content-length"] = String(body.length);
    let upstreamActual: http.ClientRequest | null = null;
    res.on("close", () => {
      if (!res.writableFinished) upstreamActual?.destroy();
    });
    try {
      const up = await enviarUpstream(req.method ?? "GET", rutaYQuery, cabecerasSalida(req.headers, extra), body, (r) => {
        upstreamActual = r;
      });
      log(`${req.method} ${ruta} passthrough status=${up.statusCode ?? 0}`);
      pasarStreaming(up, res);
    } catch (e) {
      log(`${req.method} ${ruta} passthrough ERROR: ${descError(e)}`);
      if (!res.headersSent) jsonError(res, 502, "api_error", `claude-relevo: no se pudo contactar a ${UPSTREAM.host}`);
    }
  }

  async function manejarOtras(req: IncomingMessage, res: ServerResponse, rutaYQuery: string, ruta: string): Promise<void> {
    let body: Buffer;
    try {
      body = await leerBody(req);
    } catch (e) {
      if (e instanceof ClienteCorto) {
        log(`${req.method} ${ruta} cliente corto durante la subida del body`);
        return;
      }
      throw e;
    }
    await reenviarTal(req, res, rutaYQuery, ruta, body);
  }

  const servidor = http.createServer((req, res) => {
    try {
      atender(req, res);
    } catch (e) {
      log(`ERROR interno sincrono: ${(e as Error).message}`);
      if (!res.headersSent) jsonError(res, 502, "api_error", "claude-relevo: error interno");
      else res.destroy();
    }
  });

  function atender(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const ruta = q === -1 ? url : url.slice(0, q);

    if (ruta === "/__relevo/salud" && req.method === "GET") {
      const c = JSON.stringify({ ok: true });
      res.writeHead(200, { "content-type": "application/json", "content-length": c.length });
      res.end(c);
      return;
    }
    if (!llaveValida(req.headers["x-relevo-llave"], llave)) {
      jsonError(res, 403, "permission_error", "claude-relevo: llave invalida");
      req.resume();
      return;
    }
    if (ruta === "/__relevo/estado" && req.method === "GET") {
      const c = JSON.stringify(cuentas.vista());
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(c) });
      res.end(c);
      return;
    }
    const esMensajes = ruta === "/v1/messages" || ruta.startsWith("/v1/messages/");
    const tarea = esMensajes ? manejarMensajes(req, res, url, ruta) : manejarOtras(req, res, url, ruta);
    tarea.catch((e: unknown) => {
      log(`ERROR interno en ${ruta}: ${(e as Error).message}`);
      if (!res.headersSent) jsonError(res, 502, "api_error", "claude-relevo: error interno");
      else res.destroy();
    });
  }
  servidor.requestTimeout = 0;
  servidor.timeout = 0;
  return servidor;
}
