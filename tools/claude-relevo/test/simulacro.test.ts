// SIMULACRO: upstream falso local. Prueba la logica de cambio de cuenta, no la API real.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import net from "node:net";
import { reescribirBody } from "../src/proxy.ts";

const REPO = join(import.meta.dirname, "..");
const NODE = process.execPath;
const RAIZ = mkdtempSync(join(REPO, "prueba", "sim-"));

interface Visto {
  token: string;
  uuid: string | null;
}
type Manejador = (req: http.IncomingMessage, res: http.ServerResponse, visto: Visto) => void;

let manejadores = new Map<string, Manejador>();
let vistos: Visto[] = [];
let upstream: http.Server;
let upPuerto = 0;
let cierresUpstream = 0;

const ahoraS = (): number => Math.floor(Date.now() / 1000);
const uuidDe = (n: string): string => `uuid-${n}-0000`;

function crearCuenta(nombre: string, token: string, email?: string): { dir: string; claudeJson: string } {
  const dir = join(RAIZ, "perfil-" + nombre);
  mkdirSync(dir, { recursive: true });
  escribirCred(dir, token);
  const claudeJson = join(dir, ".claude.json");
  writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { accountUuid: uuidDe(nombre), ...(email ? { emailAddress: email } : {}) } }));
  return { dir, claudeJson };
}

function escribirCred(dir: string, token: string, expiraEn = 36_000_000): void {
  const fut = Date.now() + 36_000_000;
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r-" + token, expiresAt: Date.now() + expiraEn, refreshTokenExpiresAt: fut * 2 } }),
  );
}

before(async () => {
  mkdirSync(join(REPO, "prueba"), { recursive: true });
  upstream = http.createServer((req, res) => {
    const token = String(req.headers["authorization"] ?? "").replace("Bearer ", "");
    const partes: Buffer[] = [];
    req.on("data", (d: Buffer) => partes.push(d));
    req.on("end", () => {
      let uuid: string | null = null;
      try {
        const b = JSON.parse(Buffer.concat(partes).toString()) as { metadata?: { user_id?: string } };
        uuid = (JSON.parse(b.metadata?.user_id ?? "{}") as { account_uuid?: string }).account_uuid ?? null;
      } catch {
        // sin body
      }
      const v = { token, uuid };
      vistos.push(v);
      res.on("close", () => {
        if (!res.writableFinished) cierresUpstream++;
      });
      const m = manejadores.get(token);
      if (m) m(req, res, v);
      else {
        res.writeHead(500);
        res.end("token desconocido");
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upPuerto = (upstream.address() as AddressInfo).port;
});
after(() => {
  upstream.closeAllConnections();
  upstream.close();
});

const ok = (extra: Record<string, string> = {}): Manejador => (_q, res, v) => {
  res.writeHead(200, {
    "content-type": "application/json",
    "x-visto-uuid": v.uuid ?? "",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.10",
    "anthropic-ratelimit-unified-7d-utilization": "0.20",
    "anthropic-ratelimit-unified-5h-reset": String(ahoraS() + 1000),
    "anthropic-ratelimit-unified-7d-reset": String(ahoraS() + 90000),
    ...extra,
  });
  res.end('{"ok":true}');
};
const rechazo = (resetS: number): Manejador => (_q, res) => {
  res.writeHead(429, {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(resetS),
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });
  res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `reset ${resetS}` } }));
};
const pasajero = (retryAfter?: number): Manejador => (_q, res) => {
  res.writeHead(429, { "content-type": "application/json", ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}) });
  res.end('{"type":"error","error":{"type":"rate_limit_error","message":"pasajero"}}');
};
const noAuth: Manejador = (_q, res) => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end('{"type":"error","error":{"type":"authentication_error","message":"x"}}');
};

interface Banco {
  puerto: number;
  llave: string;
  proc: ChildProcess;
  dirEstado: string;
  dirCfg: string;
  perfiles: Record<string, string>;
  claudeLog: string;
  log: () => string;
  parar: () => Promise<void>;
}

async function iniciarProxy(
  nombres: string[],
  opciones: { umbral?: Record<string, number>; evitarExtra?: boolean } = {},
): Promise<Banco> {
  const id = Math.random().toString(36).slice(2, 8);
  const dirCfg = join(RAIZ, "cfg-" + id);
  const dirEstado = join(RAIZ, "est-" + id);
  mkdirSync(dirCfg, { recursive: true });
  const perfiles: Record<string, string> = {};
  const cuentas = nombres.map((n) => {
    const c = crearCuenta(n + id, "tok-" + n, `${n}@t.com`);
    perfiles[n] = c.dir;
    const umbral = opciones.umbral?.[n];
    return { nombre: n, dir: c.dir, claudeJson: c.claudeJson, ...(umbral !== undefined ? { umbral } : {}) };
  });
  const puerto = 48000 + Math.floor(Math.random() * 1500);
  writeFileSync(join(dirCfg, "cuentas.json"), JSON.stringify({ puerto, evitarExtra: opciones.evitarExtra ?? true, cuentas }));
  const claudeLog = join(dirEstado, "fake-claude.log");
  mkdirSync(dirEstado, { recursive: true });
  const proc = spawn(NODE, [join(REPO, "src", "relevo.ts")], {
    env: {
      ...process.env,
      RELEVO_CONFIG_DIR: dirCfg,
      RELEVO_STATE_DIR: dirEstado,
      RELEVO_UPSTREAM: `http://127.0.0.1:${upPuerto}`,
      RELEVO_CLAUDE_BIN: join(REPO, "test", "fake-claude.sh"),
      RELEVO_SIN_NOTIFY: "1",
      FAKE_CLAUDE_LOG: claudeLog,
    },
    stdio: "ignore",
  });
  const rutaLog = join(dirEstado, "relevo.log");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/__relevo/salud`);
      if (r.ok) break;
    } catch {
      // aun no
    }
  }
  const llave = readFileSync(join(dirCfg, "llave"), "utf8").trim();
  return {
    puerto,
    llave,
    proc,
    dirEstado,
    dirCfg,
    perfiles,
    claudeLog,
    log: () => (existsSync(rutaLog) ? readFileSync(rutaLog, "utf8") : ""),
    parar: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    },
  };
}

function peticion(b: Banco, uuid = "uuid-original", body?: string): Promise<Response> {
  const cuerpo = body ?? JSON.stringify({ model: "x", metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: uuid, session_id: "s" }) } });
  return fetch(`http://127.0.0.1:${b.puerto}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "x-relevo-llave": b.llave, authorization: "Bearer token-original-del-cliente", "content-type": "application/json" },
    body: cuerpo,
  });
}

describe("SIMULACRO relevo", () => {
  test("429 en la primera cuenta: repite con la segunda, antes de responder; reescribe account_uuid", async () => {
    const b = await iniciarProxy(["a", "b", "c"]);
    manejadores = new Map([["tok-a", rechazo(ahoraS() + 3600)], ["tok-b", ok()], ["tok-c", ok()]]);
    vistos = [];
    try {
      const r = await peticion(b);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-b"]);
      assert.equal(vistos[1]?.uuid, uuidDe("b" + b.dirCfg.split("cfg-")[1]));
      assert.equal(r.headers.get("x-visto-uuid"), vistos[1]?.uuid);
      vistos = [];
      await peticion(b);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-b"], "a sigue agotada, va directo a b");
      assert.ok(b.log().includes("CAMBIO a@t.com agotada"), "log de cambio");
      const est = await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text();
      assert.ok(!est.includes("tok-"), "el estado no muestra tokens");
      const o = JSON.parse(est) as { activa: string; cuentas: { nombre: string; estado: string }[] };
      assert.equal(o.activa, "b@t.com");
      assert.equal(o.cuentas[0]?.estado, "agotada");
      assert.ok(!b.log().includes("tok-"), "el log no tiene tokens");
    } finally {
      await b.parar();
    }
  });

  test("todas rechazadas: devuelve el 429 con reset mas cercano (headers+body originales)", async () => {
    const b = await iniciarProxy(["a", "b", "c"]);
    const t = ahoraS();
    manejadores = new Map([["tok-a", rechazo(t + 5000)], ["tok-b", rechazo(t + 900)], ["tok-c", rechazo(t + 7000)]]);
    try {
      const r = await peticion(b);
      assert.equal(r.status, 429);
      assert.equal(r.headers.get("anthropic-ratelimit-unified-reset"), String(t + 900));
      assert.ok((await r.text()).includes(`reset ${t + 900}`));
    } finally {
      await b.parar();
    }
  });

  test("429 sin headers unified = pasajero: enfria 60 s (o retry-after con tope 5 min) y pasa a la siguiente", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", pasajero()], ["tok-b", ok()]]);
    vistos = [];
    try {
      const r = await peticion(b);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-b"]);
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { estado: string; agotadaHasta: number; motivo: string }[] };
      assert.equal(est.cuentas[0]?.estado, "enfriando");
      assert.equal(est.cuentas[0]?.motivo, "429 pasajero");
      const dt = (est.cuentas[0]?.agotadaHasta ?? 0) - ahoraS();
      assert.ok(dt > 55 && dt <= 60, `enfriamiento ${dt}s`);
      assert.ok(!b.log().includes("agotada ("), "no se loguea como agotada");
    } finally {
      await b.parar();
    }
    const c = await iniciarProxy(["a"]);
    manejadores = new Map([["tok-a", pasajero(9999)]]);
    try {
      const r = await peticion(c);
      assert.equal(r.status, 429, "sin otra cuenta: el 429 pasa tal cual");
      assert.ok((await r.text()).includes("pasajero"));
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${c.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": c.llave } })).text()) as { cuentas: { agotadaHasta: number }[] };
      const dt = (est.cuentas[0]?.agotadaHasta ?? 0) - ahoraS();
      assert.ok(dt > 295 && dt <= 300, `retry-after con tope 300: ${dt}s`);
    } finally {
      await c.parar();
    }
  });

  test("todas agotadas (no muertas): se intenta la mas cercana; si responde 200 se limpia la marca", async () => {
    const b = await iniciarProxy(["a", "b"]);
    const t = ahoraS();
    manejadores = new Map([["tok-a", rechazo(t + 5000)], ["tok-b", rechazo(t + 900)]]);
    try {
      const r1 = await peticion(b);
      assert.equal(r1.status, 429);
      vistos = [];
      const r2 = await peticion(b);
      assert.equal(r2.status, 429, "sigue siendo un 429 real de upstream, no un 401 inventado");
      assert.deepEqual(vistos.map((v) => v.token), ["tok-b", "tok-a"], "ultimo recurso: se prueban todas, la de reset mas cercano primero");
      manejadores = new Map([["tok-a", rechazo(t + 5000)], ["tok-b", ok()]]);
      const r3 = await peticion(b);
      assert.equal(r3.status, 200);
      assert.ok(b.log().includes("se limpia la marca"));
    } finally {
      await b.parar();
    }
  });

  test("401: refresco via claude falso (single-flight) y reintento con token nuevo", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", noAuth], ["tok-a2", ok()], ["tok-b", ok()]]);
    writeFileSync(join(b.perfiles["a"] as string, ".rotar"), "tok-a2");
    vistos = [];
    try {
      const [r1, r2] = await Promise.all([peticion(b), peticion(b)]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.ok(vistos.some((v) => v.token === "tok-a2"));
      assert.ok(!vistos.some((v) => v.token === "tok-b"), "no se salto a b");
      const llamadas = readFileSync(b.claudeLog, "utf8").trim().split("\n");
      assert.equal(llamadas.length, 1, "single-flight: una sola ejecucion de claude");
      assert.ok(llamadas[0]?.includes(`dir=${b.perfiles["a"]}`));
      assert.ok(llamadas[0]?.includes("-p /usage"));
    } finally {
      await b.parar();
    }
  });

  test("401 persistente tras refresco: cuenta muerta y sigue con la siguiente; el 401 nunca llega al cliente", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", noAuth], ["tok-b", ok()]]);
    try {
      const r = await peticion(b);
      assert.equal(r.status, 200);
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { estado: string; agotadaHasta: number }[] };
      assert.equal(est.cuentas[0]?.estado, "enfriando", "refresco sin cambio NO mata la cuenta (hallazgo 4)");
      const dt = (est.cuentas[0]?.agotadaHasta ?? 0) - ahoraS();
      assert.ok(dt > 115 && dt <= 120, `backoff 2 min: ${dt}s`);
    } finally {
      await b.parar();
    }
    const c = await iniciarProxy(["a"]);
    manejadores = new Map([["tok-a", noAuth]]);
    try {
      const r = await peticion(c);
      assert.equal(r.status, 401, "sin otra cuenta se devuelve el 401 de upstream");
    } finally {
      await c.parar();
    }
  });

  test("H4: 401 aun con token renovado por el refresco -> muerta", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", noAuth], ["tok-a2", noAuth], ["tok-b", ok()]]);
    writeFileSync(join(b.perfiles["a"] as string, ".rotar"), "tok-a2");
    try {
      const r = await peticion(b);
      assert.equal(r.status, 200);
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { estado: string }[] };
      assert.equal(est.cuentas[0]?.estado, "muerta");
    } finally {
      await b.parar();
    }
  });

  test("H1: sin ninguna lista se prueban TODAS en orden blanda, enfriando, cupo", async () => {
    const b = await iniciarProxy(["a", "b", "c"], { umbral: { c: 0.05 } });
    const t = ahoraS();
    manejadores = new Map([["tok-a", pasajero()], ["tok-b", rechazo(t + 900)], ["tok-c", ok()]]);
    vistos = [];
    try {
      await peticion(b); // a enfria, b cupo, c sirve y queda blanda por umbral
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-b", "tok-c"]);
      vistos = [];
      manejadores = new Map([["tok-a", pasajero()], ["tok-b", ok()], ["tok-c", rechazo(t + 800)]]);
      const r = await peticion(b);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-c", "tok-a", "tok-b"], "blanda (c), enfriando (a), cupo (b)");
      vistos = [];
      manejadores = new Map([["tok-a", pasajero()], ["tok-b", rechazo(t + 900)], ["tok-c", rechazo(t + 800)]]);
      const r2 = await peticion(b);
      assert.equal(r2.status, 429, "si todas fallan: 429 con reset mas cercano");
    } finally {
      await b.parar();
    }
  });

  test("H2: un 200 retrasado no borra una marca agotada puesta despues de que salio", async () => {
    const b = await iniciarProxy(["a", "b"]);
    let llamadasA = 0;
    manejadores = new Map([
      [
        "tok-a",
        (q, res, v) => {
          llamadasA++;
          if (llamadasA === 1) setTimeout(() => ok()(q, res, v), 600);
          else rechazo(ahoraS() + 3000)(q, res, v);
        },
      ],
      ["tok-b", ok()],
    ]);
    try {
      const lenta = peticion(b);
      await new Promise((r) => setTimeout(r, 150));
      const rapida = await peticion(b); // a rechaza (marca) y sirve b
      assert.equal(rapida.status, 200);
      assert.equal((await lenta).status, 200);
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { estado: string }[] };
      assert.equal(est.cuentas[0]?.estado, "agotada", "la marca posterior sobrevive al 200 retrasado");
    } finally {
      await b.parar();
    }
  });

  test("H3: refresco con espera minima de 60 s; token vigente se usa, token vencido -> enfriando", async () => {
    const b = await iniciarProxy(["a", "b"]);
    escribirCred(b.perfiles["a"] as string, "tok-a", 60_000); // vence en 1 min (< 5 min), sigue vigente
    manejadores = new Map([["tok-a", ok()], ["tok-b", ok()]]);
    vistos = [];
    try {
      await peticion(b);
      await peticion(b);
      await peticion(b);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-a", "tok-a"], "usa el token vigente");
      assert.equal(readFileSync(b.claudeLog, "utf8").trim().split("\n").length, 1, "un solo refresco en 3 peticiones");
    } finally {
      await b.parar();
    }
    const c = await iniciarProxy(["a", "b"]);
    escribirCred(c.perfiles["a"] as string, "tok-a", -1000); // ya vencido
    manejadores = new Map([["tok-a", ok()], ["tok-b", ok()]]);
    vistos = [];
    try {
      const r = await peticion(c);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-b"], "vencido y sin renovar: enfriando, sirve b");
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${c.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": c.llave } })).text()) as { cuentas: { estado: string }[] };
      assert.equal(est.cuentas[0]?.estado, "enfriando");
    } finally {
      await c.parar();
    }
  });

  test("H5: todas muertas (o sin cuentas) -> se reenvia con el Authorization original, body intacto", async () => {
    for (const nombres of [["a", "b"], []]) {
      const b = await iniciarProxy(nombres);
      for (const n of nombres) writeFileSync(join(b.perfiles[n] as string, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }));
      manejadores = new Map([["token-original-del-cliente", ok()]]);
      vistos = [];
      try {
        const r = await peticion(b, "uuid-original");
        assert.equal(r.status, 200, `nombres=${nombres.length}`);
        assert.equal(vistos[0]?.token, "token-original-del-cliente");
        assert.equal(vistos[0]?.uuid, "uuid-original", "metadata sin reescribir");
        assert.ok(!existsSync(b.claudeLog), "claude no se ejecuto");
      } finally {
        await b.parar();
      }
    }
  });

  test("H7: si el cliente aborta mientras se espera el refresco no se manda nada upstream", async () => {
    const b = await iniciarProxy(["a"]);
    escribirCred(b.perfiles["a"] as string, "tok-a", 60_000);
    manejadores = new Map([["tok-a", ok()]]);
    vistos = [];
    const ac = new AbortController();
    try {
      const p = fetch(`http://127.0.0.1:${b.puerto}/v1/messages`, { method: "POST", headers: { "x-relevo-llave": b.llave }, body: "{}", signal: ac.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 60));
      ac.abort();
      await p;
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(vistos.length, 0, "nada llego a upstream");
      assert.ok(existsSync(b.claudeLog), "el refresco si arranco (fue lo que se espero)");
    } finally {
      await b.parar();
    }
  });

  test("H8: aborto del cliente durante la subida del body se loguea como cliente corto, no ERROR", async () => {
    const b = await iniciarProxy(["a"]);
    manejadores = new Map([["tok-a", ok()]]);
    try {
      await new Promise<void>((resolve) => {
        const s = net.connect(b.puerto, "127.0.0.1", () => {
          s.write(`POST /v1/messages HTTP/1.1\r\nhost: x\r\nx-relevo-llave: ${b.llave}\r\ncontent-length: 100\r\n\r\nparcial`);
          setTimeout(() => {
            s.destroy();
            resolve();
          }, 100);
        });
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(b.log().includes("cliente corto durante la subida"));
      assert.ok(!b.log().includes("ERROR"));
    } finally {
      await b.parar();
    }
  });

  test("A: perfil que cambia de cuenta reinicia el estado y el uuid nuevo se usa de inmediato", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", rechazo(ahoraS() + 3000)], ["tok-a2", ok()], ["tok-b", ok()]]);
    try {
      await peticion(b); // a agotada, sirve b
      const dirA = b.perfiles["a"] as string;
      writeFileSync(join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "otra-cuenta" } }));
      escribirCred(dirA, "tok-a2");
      vistos = [];
      const r = await peticion(b);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a2"], "no hereda la marca agotada");
      assert.equal(vistos[0]?.uuid, "otra-cuenta", "token nuevo con uuid nuevo");
      assert.ok(b.log().includes("cambio de cuenta"));
    } finally {
      await b.parar();
    }
  });

  test("B: dos perfiles con la misma cuenta -> el de menor prioridad queda duplicada, sin refresco ni spam", async () => {
    const b = await iniciarProxy(["a", "b"]);
    const dirB = b.perfiles["b"] as string;
    const uuidA = JSON.parse(readFileSync(join(b.perfiles["a"] as string, ".claude.json"), "utf8")).oauthAccount.accountUuid as string;
    writeFileSync(join(dirB, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: uuidA } }));
    escribirCred(dirB, "tok-b", 60_000); // por vencer: habria refresco si no fuera duplicada
    manejadores = new Map([["tok-a", rechazo(ahoraS() + 3000)], ["tok-b", ok()]]);
    vistos = [];
    try {
      await peticion(b);
      await peticion(b);
      await peticion(b);
      assert.ok(!vistos.some((v) => v.token === "tok-b"), "la duplicada nunca recibe trafico");
      assert.ok(!existsSync(b.claudeLog), "ni refresco");
      const est = JSON.parse(await (await fetch(`http://127.0.0.1:${b.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { estado: string; motivo: string }[] };
      assert.equal(est.cuentas[1]?.estado, "duplicada");
      assert.equal(est.cuentas[1]?.motivo, "misma cuenta que a@t.com");
      assert.equal(b.log().split("DUPLICADA").length - 1, 1, "una sola linea de log");
    } finally {
      await b.parar();
    }
  });

  test("C: estado.json con basura se descarta con aviso", async () => {
    const id = Math.random().toString(36).slice(2, 8);
    const b0 = await iniciarProxy(["a"]);
    await b0.parar();
    writeFileSync(join(b0.dirEstado, "estado.json"), JSON.stringify({ cuentas: { a: { agotadaHasta: "x", marca: "rara", util5h: 999, muerta: 7 } } }));
    manejadores = new Map([["tok-a", ok()]]);
    const proc = spawn(NODE, [join(REPO, "src", "relevo.ts")], {
      env: { ...process.env, RELEVO_CONFIG_DIR: b0.dirCfg, RELEVO_STATE_DIR: b0.dirEstado, RELEVO_UPSTREAM: `http://127.0.0.1:${upPuerto}`, RELEVO_SIN_NOTIFY: "1" },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const log = readFileSync(join(b0.dirEstado, "relevo.log"), "utf8");
      assert.ok(log.includes("campos invalidos descartados en a"), id);
      assert.ok(log.includes("cuenta=a@t.com estado=lista"));
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });

  test("D: perfil inexistente = muerta (sin login) sin spam; se toma sola al aparecer", async () => {
    const b = await iniciarProxy(["a"]);
    await b.parar();
    const dirP3 = join(RAIZ, "perfil-p3-" + Math.random().toString(36).slice(2, 6));
    const cfg = JSON.parse(readFileSync(join(b.dirCfg, "cuentas.json"), "utf8")) as { cuentas: unknown[] };
    cfg.cuentas.push({ nombre: "p3", dir: dirP3, claudeJson: join(dirP3, ".claude.json") });
    writeFileSync(join(b.dirCfg, "cuentas.json"), JSON.stringify(cfg));
    // a muerta para que p3 sea la unica opcion cuando aparezca
    writeFileSync(join(b.perfiles["a"] as string, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }));
    const proc = spawn(NODE, [join(REPO, "src", "relevo.ts")], {
      env: { ...process.env, RELEVO_CONFIG_DIR: b.dirCfg, RELEVO_STATE_DIR: b.dirEstado, RELEVO_UPSTREAM: `http://127.0.0.1:${upPuerto}`, RELEVO_SIN_NOTIFY: "1" },
      stdio: "ignore",
    });
    manejadores = new Map([["tok-p3", ok()]]);
    vistos = [];
    const pto = (cfg as unknown as { puerto: number }).puerto;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${pto}/v1/messages`, { method: "POST", headers: { "x-relevo-llave": b.llave, authorization: "Bearer orig" }, body: "{}" });
      const log1 = readFileSync(join(b.dirEstado, "relevo.log"), "utf8");
      assert.ok(log1.includes("cuenta=p3 (sin login) MUERTA (sin login)"));
      assert.equal(log1.split("cuenta=p3 (sin login) MUERTA").length - 1, 1, "sin spam");
      assert.ok(!log1.includes("ERROR"));
      mkdirSync(dirP3, { recursive: true });
      writeFileSync(join(dirP3, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-p3" } }));
      escribirCred(dirP3, "tok-p3");
      vistos = [];
      const r = await fetch(`http://127.0.0.1:${pto}/v1/messages`, { method: "POST", headers: { "x-relevo-llave": b.llave }, body: "{}" });
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-p3"]);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });

  test("D2 (regresion prod): con la primera cuenta viva, una muerta revive sola por estado y por ruteo al aparecer su login", async () => {
    const b = await iniciarProxy(["a"]);
    await b.parar();
    const dirX = join(RAIZ, "perfil-x-" + Math.random().toString(36).slice(2, 6));
    const dirY = join(RAIZ, "perfil-y-" + Math.random().toString(36).slice(2, 6));
    const cfg = JSON.parse(readFileSync(join(b.dirCfg, "cuentas.json"), "utf8")) as { puerto: number; cuentas: unknown[] };
    cfg.cuentas.push({ nombre: "x", dir: dirX, claudeJson: join(dirX, ".claude.json") }, { nombre: "y", dir: dirY, claudeJson: join(dirY, ".claude.json") });
    writeFileSync(join(b.dirCfg, "cuentas.json"), JSON.stringify(cfg));
    const proc = spawn(NODE, [join(REPO, "src", "relevo.ts")], {
      env: { ...process.env, RELEVO_CONFIG_DIR: b.dirCfg, RELEVO_STATE_DIR: b.dirEstado, RELEVO_UPSTREAM: `http://127.0.0.1:${upPuerto}`, RELEVO_SIN_NOTIFY: "1" },
      stdio: "ignore",
    });
    const estado = async (): Promise<Record<string, string>> => {
      const o = JSON.parse(await (await fetch(`http://127.0.0.1:${cfg.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as { cuentas: { nombre: string; estado: string }[] };
      return Object.fromEntries(o.cuentas.map((c) => [c.nombre, c.estado]));
    };
    try {
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(await estado(), { a: "lista", x: "muerta", y: "muerta" });
      // logins DESPUES de arrancar; "a" sigue viva y no pasa ninguna peticion
      for (const [n, d] of [["x", dirX], ["y", dirY]] as const) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-" + n } }));
        escribirCred(d, "tok-" + n);
      }
      assert.deepEqual(await estado(), { a: "lista", x: "lista", y: "lista" }, "estado reevalua todas sin trafico");
      // muerta con archivo que cambia (relogin): tambien revive
      writeFileSync(join(dirX, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }));
      assert.equal((await estado())["x"], "muerta");
      await new Promise((r) => setTimeout(r, 20));
      escribirCred(dirX, "tok-x2");
      manejadores = new Map([["tok-a", rechazo(ahoraS() + 3000)], ["tok-x2", ok()], ["tok-y", ok()]]);
      vistos = [];
      const r = await fetch(`http://127.0.0.1:${cfg.puerto}/v1/messages`, { method: "POST", headers: { "x-relevo-llave": b.llave }, body: "{}" });
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-x2"], "ruteo usa la cuenta revivida");
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });

  test("E: las cuentas se muestran por correo (en vivo) o etiqueta; sin login muestra el perfil", async () => {
    const b = await iniciarProxy(["a", "b"]);
    await b.parar();
    const dirA = b.perfiles["a"] as string;
    const dirB = b.perfiles["b"] as string;
    writeFileSync(join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "ua", emailAddress: "uno@ejemplo.com" } }));
    writeFileSync(join(dirB, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "ub", emailAddress: "dos@ejemplo.com" } }));
    const cfg = JSON.parse(readFileSync(join(b.dirCfg, "cuentas.json"), "utf8")) as { puerto: number; cuentas: Record<string, unknown>[] };
    cfg.cuentas[1] = { ...cfg.cuentas[1], etiqueta: "empresa" };
    const dirZ = join(RAIZ, "perfil-z-" + Math.random().toString(36).slice(2, 6));
    cfg.cuentas.push({ nombre: "z", dir: dirZ, claudeJson: join(dirZ, ".claude.json") });
    writeFileSync(join(b.dirCfg, "cuentas.json"), JSON.stringify(cfg));
    const proc = spawn(NODE, [join(REPO, "src", "relevo.ts")], {
      env: { ...process.env, RELEVO_CONFIG_DIR: b.dirCfg, RELEVO_STATE_DIR: b.dirEstado, RELEVO_UPSTREAM: `http://127.0.0.1:${upPuerto}`, RELEVO_SIN_NOTIFY: "1" },
      stdio: "ignore",
    });
    const estado = async (): Promise<{ activa: string; cuentas: { nombre: string; correo: string }[] }> =>
      JSON.parse(await (await fetch(`http://127.0.0.1:${cfg.puerto}/__relevo/estado`, { headers: { "x-relevo-llave": b.llave } })).text()) as never;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      let e = await estado();
      assert.deepEqual(e.cuentas.map((c) => [c.nombre, c.correo]), [["a", "uno@ejemplo.com"], ["b", "empresa"], ["z", "z (sin login)"]]);
      assert.equal(e.activa, "uno@ejemplo.com");
      // el perfil cambia de cuenta: el correo cambia solo
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "ua2", emailAddress: "nuevo@ejemplo.com" } }));
      escribirCred(dirA, "tok-a");
      e = await estado();
      assert.equal(e.cuentas[0]?.correo, "nuevo@ejemplo.com");
      const log = readFileSync(join(b.dirEstado, "relevo.log"), "utf8");
      assert.ok(log.includes("cuenta=z (sin login) MUERTA"));
      assert.ok(log.includes("nuevo@ejemplo.com cambio de cuenta"));
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });

  test("H6: reescribirBody es quirurgico (un solo reemplazo exacto, sin tocar el resto)", () => {
    const inner = JSON.stringify({ device_id: "d", account_uuid: "uuid-viejo", session_id: "s" });
    const cuerpo = `{ "model":"x",\n "messages":[{"role":"user","content":"mi uuid-viejo aparece aqui y account_uuid tambien"}],\n "metadata": {"user_id" :   ${JSON.stringify(inner)} } }`;
    const r = reescribirBody(Buffer.from(cuerpo), "uuid-nuevo");
    const txt = r.body.toString();
    assert.equal(r.aviso, null);
    assert.ok(txt.includes("mi uuid-viejo aparece aqui"), "el texto de la conversacion no se toca");
    assert.ok(txt.includes("uuid-nuevo"));
    assert.equal(txt.replace(/uuid-nuevo/, "uuid-viejo"), cuerpo, "solo cambio ese uuid; espacios y formato intactos");
    // user_id identico dos veces en el texto crudo: no se reescribe
    const dup = `{"metadata":{"user_id":${JSON.stringify(inner)}},"otro":{"user_id":${JSON.stringify(inner)}}}`;
    const r2 = reescribirBody(Buffer.from(dup), "uuid-nuevo");
    assert.equal(r2.body.toString(), dup);
    assert.ok(r2.aviso);
  });

  test("cuenta muerta (sin refreshToken) no ejecuta claude", async () => {
    const b = await iniciarProxy(["a", "b"]);
    writeFileSync(join(b.perfiles["a"] as string, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    manejadores = new Map([["tok-b", ok()]]);
    vistos = [];
    try {
      const r = await peticion(b);
      assert.equal(r.status, 200);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-b"]);
      assert.ok(!existsSync(b.claudeLog), "claude no se ejecuto");
    } finally {
      await b.parar();
    }
  });

  test("umbral 0.05: tras un 200 con util 0.10 la siguiente peticion va a la otra cuenta", async () => {
    const b = await iniciarProxy(["a", "b"], { umbral: { a: 0.05 } });
    manejadores = new Map([["tok-a", ok()], ["tok-b", ok()]]);
    vistos = [];
    try {
      await peticion(b);
      await peticion(b);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-b"]);
    } finally {
      await b.parar();
    }
  });

  test("evitarExtra: overage-in-use=true marca agotada si hay otra cuenta", async () => {
    const b = await iniciarProxy(["a", "b"]);
    manejadores = new Map([["tok-a", ok({ "anthropic-ratelimit-unified-overage-in-use": "true" })], ["tok-b", ok()]]);
    vistos = [];
    try {
      await peticion(b);
      await peticion(b);
      assert.deepEqual(vistos.map((v) => v.token), ["tok-a", "tok-b"]);
    } finally {
      await b.parar();
    }
  });

  test("SSE: el primer chunk llega antes de que termine el upstream; cliente que corta aborta upstream", async () => {
    const b = await iniciarProxy(["a"]);
    manejadores = new Map([
      [
        "tok-a",
        (_q, res) => {
          res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
          res.write("event: ping\ndata: 1\n\n");
          const t = setInterval(() => res.write("event: ping\ndata: 2\n\n"), 200);
          res.on("close", () => clearInterval(t));
          setTimeout(() => res.end("event: fin\ndata: 3\n\n"), 1500);
        },
      ],
    ]);
    const t0 = Date.now();
    const ac = new AbortController();
    const antes = cierresUpstream;
    try {
      const r = await fetch(`http://127.0.0.1:${b.puerto}/v1/messages`, {
        method: "POST",
        headers: { "x-relevo-llave": b.llave },
        body: "{}",
        signal: ac.signal,
      });
      const lector = (r.body as ReadableStream<Uint8Array>).getReader();
      const primero = await lector.read();
      const dt = Date.now() - t0;
      assert.ok(!primero.done && dt < 800, `primer chunk en ${dt} ms`);
      ac.abort();
      await new Promise((r2) => setTimeout(r2, 400));
      assert.equal(cierresUpstream, antes + 1, "upstream abortado al cortar el cliente");
    } finally {
      await b.parar();
    }
  });

  test("otras rutas: pasan el Authorization original y sin llave", async () => {
    const b = await iniciarProxy(["a"]);
    let visto: http.IncomingHttpHeaders = {};
    manejadores = new Map([["token-original-del-cliente", (q, res) => { visto = q.headers; res.writeHead(200); res.end("x"); }]]);
    try {
      const r = await fetch(`http://127.0.0.1:${b.puerto}/api/oauth/profile`, { headers: { "x-relevo-llave": b.llave, authorization: "Bearer token-original-del-cliente" } });
      assert.equal(r.status, 200);
      assert.equal(visto["x-relevo-llave"], undefined);
      const sin = await fetch(`http://127.0.0.1:${b.puerto}/api/oauth/profile`);
      assert.equal(sin.status, 403);
    } finally {
      await b.parar();
    }
  });
});
