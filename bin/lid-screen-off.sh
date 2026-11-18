#!/usr/bin/env bash
# Apaga la pantalla (DPMS off) mientras la tapa este cerrada.
# No suspende el equipo: los servicios locales siguen corriendo.
# Arranca desde ~/.config/autostart/lid-screen-off.desktop

LID_STATE=${LID_STATE_FILE:-$(ls /proc/acpi/button/lid/*/state 2>/dev/null | head -1)}
[ -n "$LID_STATE" ] || exit 0

export DISPLAY="${DISPLAY:-:0}"

prev=open
while :; do
    state=$(awk '{print $2}' "$LID_STATE" 2>/dev/null)

    if [ "$state" = closed ]; then
        # xfce4-power-manager puede volver a desactivar DPMS, por eso se
        # reactiva en cada vuelta; tambien reapaga si algo despierta el panel.
        xset +dpms
        xset dpms force off
    elif [ "$prev" = closed ]; then
        xset dpms force on
    fi

    prev=$state
    sleep 5
done
