# claude-toolkit

Mis herramientas de Claude Code para tenerlas iguales en cualquier PC: skills, configuracion,
servidores MCP, hooks y scripts. Sin datos personales ni claves.

La memoria (lo que Claude sabe de mi y de mis proyectos) va aparte, en un repo **privado**.
`install.sh` la trae si tu cuenta de GitHub tiene acceso.

## PC nuevo

```bash
git clone https://github.com/Killgreck/claude-toolkit ~/claude-sync/claude-toolkit
~/claude-sync/claude-toolkit/install.sh            # herramientas + memoria privada
~/claude-sync/claude-toolkit/install.sh --sin-memoria
```

Al final imprime la lista de lo que toca hacer a mano (logins, QR de WhatsApp, claves de Google).

## Que trae

| Carpeta | Que es |
|---|---|
| `skills/` | Skills propias: `caverman` (tono corto), `reunion` (grabar y transcribir reuniones) |
| `settings/settings.json` | Modelo, esfuerzo, hooks, plugins, tema. `install.sh` lo mezcla con el que haya |
| `mcp/servers.json` | Servidores MCP: whatsapp, linear, desktop-control, google-docs, aws-mcp, mempalace, canva |
| `mcp/desktop-control-mcp/` | MCP propio: pantalla, mouse y teclado (X11) |
| `mcp/whatsapp-mcp/` | Parche sobre [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) |
| `mcp/workspace-mcp/` | Lanzador de Google Docs/Drive MCP con alcance recortado |
| `hooks/mempalace-obsidian-bridge/` | Hooks que copian lo que se guarda en mempalace a Obsidian |
| `tools/claude-relevo/` | Proxy que pasa Claude Code a otra cuenta cuando se acaba el cupo |
| `tools/claude-cuentas/` + `bin/claude-*` | Perfiles de Claude por cuenta (`claude-personal1`, `claude-empresa`...) y `claude-mover` |
| `tools/reunion/` | Grabador + transcriptor local (faster-whisper) que usa la skill `reunion` |
| `bin/` | Otros scripts chicos (avisos, pantalla con tapa cerrada, Obsidian CLI) |
| `systemd/` | Timer que sincroniza la memoria cada hora |

Las rutas del home salen como `__HOME__`; `install.sh` pone la tuya.

## De terceros (no se copian aqui, se instalan de su fuente)

| Que | Como |
|---|---|
| Plugins `taste-skill`, `ui-ux-pro-max` | `install.sh` los agrega (`claude plugin install ...`) |
| `obsidian-second-brain` | <https://github.com/eugeniughelbur/obsidian-second-brain> |
| `impeccable` | `npx impeccable install` (<https://github.com/pbakaus/impeccable>) |
| Skills AWS (18) + `aws-mcp` | `aws configure agent-toolkit` (AWS CLI 2.35+) |
| `remove-ai-marks` | <https://github.com/guillaumemeyer/watermarks-remover> |
| `mempalace` | fork <https://github.com/Killgreck/mempalace> (`install.sh` lo clona) |

Si tienes acceso al repo privado, `restore.sh` de alla ya copia todas estas skills tal cual estan en el PC principal.

## Sincronizar solo

```bash
cp ~/claude-sync/claude-toolkit/systemd/claude-memoria-sync.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-memoria-sync.timer
```

Cada hora corre `~/claude-sync/claude-memoria/sync.sh`: sube lo nuevo que Claude aprendio y trae lo de otros PCs.
En el PC principal tambien regenera este toolkit con `export.sh`, que se niega a subir si encuentra
nombres, cuentas, IPs o claves (lista negra privada + gitleaks).
