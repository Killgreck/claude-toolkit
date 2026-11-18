import { cargarConfig, inicializar, leerLlave, RUTA_LOG } from "./config.ts";
import { Cuentas } from "./cuentas.ts";
import { log } from "./log.ts";
import { AVISO_UPSTREAM, crearServidor } from "./proxy.ts";

export function arrancar(): void {
  process.on("unhandledRejection", (e) => {
    log(`ERROR promesa sin manejar: ${e instanceof Error ? e.message : String(e)}`);
  });
  process.on("uncaughtException", (e) => {
    log(`ERROR excepcion sin capturar: ${e.message}`);
  });
  inicializar();
  const cfg = cargarConfig();
  const llave = leerLlave();
  const cuentas = new Cuentas(cfg.cuentas);
  const servidor = crearServidor(cfg, cuentas, llave);
  servidor.on("error", (e) => {
    log(`ERROR del servidor: ${e.message}`);
    process.stderr.write(`claude-relevo: ${e.message}\n`);
    process.exit(1);
  });
  servidor.listen(cfg.puerto, "127.0.0.1", () => {
    log(`claude-relevo escuchando en 127.0.0.1:${cfg.puerto} (log: ${RUTA_LOG})`);
    if (AVISO_UPSTREAM) {
      log(AVISO_UPSTREAM);
      process.stderr.write(AVISO_UPSTREAM + "\n");
    }
    for (const c of cuentas.lista) {
      log(`cuenta=${cuentas.nom(c)} estado=${cuentas.estadoDe(c)}${c.muerta ? " (" + c.motivoMuerta + ")" : ""}`);
    }
    cuentas.iniciarMantenimiento();
  });
  const salir = (): void => {
    cuentas.detener();
    servidor.close();
    servidor.closeAllConnections();
    process.exit(0);
  };
  process.on("SIGTERM", salir);
  process.on("SIGINT", salir);
}

arrancar();
