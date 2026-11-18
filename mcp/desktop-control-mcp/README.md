# desktop-control-mcp

MCP que le da a Claude Code control total del escritorio: **ver la pantalla** (`screenshot`)
y **manejar mouse/teclado** (`click`, `move_mouse`, `drag`, `scroll`, `type_text`, `press_key`).
Servidor de un solo archivo, sin dependencias npm (Node puro), shell-out a `xdotool` + `scrot`.

## ⚠️ Requiere sesión X11 (NO Wayland)

GNOME 49 (tu default) corre en **Wayland**, que bloquea por diseño la captura/inyección no-interactiva.
Por eso se instaló **XFCE sobre Xorg** como sesión X11 alterna.

### Activar
1. Cierra sesión (logout) en GNOME.
2. En la pantalla de login (GDM), abajo a la derecha, elige el engranaje ⚙ → **"Xfce Session"** (X11).
3. Entra. Verifica que estás en X11:  `echo $XDG_SESSION_TYPE`  → debe decir `x11`.
4. Abre una terminal **dentro de esa sesión XFCE** y lanza Claude Code desde ahí
   (así hereda `DISPLAY=:0` y el `XAUTHORITY` correctos).
5. Las herramientas `desktop-control` ya funcionan: pídele a Claude "toma un screenshot".

Tu GNOME Wayland sigue siendo el default; XFCE solo se usa cuando lo eliges en el login.

## Herramientas
- `screenshot` — captura toda la pantalla (PNG).
- `get_screen_size` / `get_cursor_position`
- `move_mouse {x,y}` · `click {x?,y?,button?,count?}` · `drag {x1,y1,x2,y2}` · `scroll {amount}`
- `type_text {text}` · `press_key {keys}`  (ej. `Return`, `ctrl+c`, `alt+Tab`)

## Seguridad
- X11 **no aísla apps**: cualquier programa en la sesión X11 puede capturar pantalla y teclas.
  Es el costo aceptado para control autónomo. Tu lockdown del host (sysctl/USBGuard/firewall) sigue intacto.
- Cuando actives **fapolicyd**, hay que permitir `node`, `xdotool`, `scrot` en el allowlist.
- El daemon `ydotoold` (instalado en el intento Wayland) quedó corriendo como root con socket
  para tu usuario. Si no usarás la ruta Wayland, conviene apagarlo:
  `sudo systemctl disable --now ydotool.service`

## Rollback total
```bash
claude mcp remove desktop-control --scope user
rm -rf __HOME__/desktop-control-mcp
sudo systemctl disable --now ydotool.service
sudo dnf remove ydotool gnome-screenshot           # tools del intento Wayland
sudo dnf group remove xfce-desktop-environment      # quita XFCE/Xorg (vuelves a solo-GNOME-Wayland)
sudo dnf remove xdotool scrot
```
