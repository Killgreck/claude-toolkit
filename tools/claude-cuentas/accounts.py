"""Named Claude Code profiles. Never copies or switches credential files."""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = Path('__HOME__/.local/share/claude-accounts')
CLAUDE = '__HOME__/.local/bin/claude'
PROFILES = {
    'empresa': '__HOME__/.claude-empresa',
    'personal1': None,  # Preserve the existing ~/.claude and ~/.claude.json pair.
    'personal2': '__HOME__/.claude-personal2',
}


def environment(account):
    if account not in PROFILES:
        raise ValueError('Cuenta desconocida: ' + account)
    env = os.environ.copy()
    # These launchers explicitly select Claude subscriptions, not API billing.
    for name in ('CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN',
                 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE'):
        env.pop(name, None)
    if PROFILES[account]:
        env['CLAUDE_CONFIG_DIR'] = PROFILES[account]
    return env


def status(account):
    try:
        result = subprocess.run([CLAUDE, 'auth', 'status'], env=environment(account),
                                capture_output=True, text=True, timeout=20)
        data = json.loads(result.stdout)
        return {'cuenta': account, 'iniciada': bool(data.get('loggedIn')),
                'correo': data.get('email'), 'plan': data.get('subscriptionType'),
                'autenticacion': data.get('authMethod')}
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        return {'cuenta': account, 'iniciada': False, 'error': type(exc).__name__}


def all_status():
    with ThreadPoolExecutor(max_workers=3) as pool:
        return list(pool.map(status, PROFILES))


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('help', '--help', '-h'):
        print('Claude con sesiones separadas:\n'
              '  claude-cuentas estado\n'
              '  claude-cuentas uso  # límites y horas de recuperación\n'
              '  claude-cuentas sesiones  # sesiones guardadas y recuperación\n'
              '  claude-cuentas guardar-sesiones  # actualizar respaldo\n'
              '  claude-cuentas reanudar-trabajo  # recuperar una sesión cerrada si hay cuota\n'
              '  claude-cuentas login empresa [correo]\n'
              '  claude-cuentas login personal2 [correo]\n'
              '  claude-cuentas configurar  # autorizar las cuentas pendientes\n'
              '  claude-empresa [opciones de Claude]\n'
              '  claude-personal1 [opciones de Claude]\n'
              '  claude-personal2 [opciones de Claude]\n'
              '  claude-cuentas abrir  # tres pestañas de terminal\n'
              '\nCada login afecta solo al perfil elegido. No uses /logout para cambiar.')
        return
    if args == ['configurar']:
        print('Configurar las cuentas pendientes de Claude Code.\n'
              'La sesión personal 1 ya guardada se conserva.\n', flush=True)
        for account, label in [('empresa', 'EMPRESA (la cuenta que paga la empresa)'),
                               ('personal2', 'PERSONAL 2 (tu otra cuenta de 20 USD)')]:
            if status(account)['iniciada']:
                print(f'{account}: ya tiene sesión iniciada.', flush=True)
                continue
            print(f'Ahora autoriza: {label}.\n'
                  'En el navegador, elige el correo correspondiente.\n'
                  'Si aparece otra cuenta, cambia de cuenta en esa página.', flush=True)
            input('Pulsa Enter para abrir el inicio de sesión (Ctrl+C para salir): ')
            result = subprocess.run([CLAUDE, 'auth', 'login', '--claudeai'],
                                    env=environment(account))
            if result.returncode:
                print(f'Login pendiente. Puedes reintentarlo con: claude-cuentas login {account}', flush=True)
                input('Pulsa Enter para cerrar: ')
                return
            item = status(account)
            if not item['iniciada']:
                raise SystemExit(f'No se confirmó la sesión de {account}. Ejecuta claude-cuentas estado.')
            print(f"Guardada {account}: {item['correo']} ({item['plan']})", flush=True)
            others = [entry for entry in all_status()
                      if entry['cuenta'] != account and entry['iniciada']
                      and entry.get('correo') == item.get('correo')]
            if others:
                print('Ese correo ya está guardado en otro perfil.\n'
                      f'Para elegir la cuenta correcta: claude-cuentas login {account}', flush=True)
                input('Pulsa Enter para cerrar: ')
                return
        print('\nConfiguración terminada. Puedes usar claude-empresa,\n'
              'claude-personal1 y claude-personal2 sin cerrar sesión.', flush=True)
        input('Pulsa Enter para cerrar: ')
        return
    if args == ['estado']:
        for item in all_status():
            state = 'INICIADA' if item['iniciada'] else 'PENDIENTE DE LOGIN'
            print(f"{item['cuenta']:10} {state:20} {item.get('correo') or ''} {item.get('plan') or ''}")
        return
    if args == ['uso']:
        from usage import usage
        with ThreadPoolExecutor(max_workers=3) as pool:
            for item in pool.map(usage, PROFILES):
                print(json.dumps(item, ensure_ascii=False, indent=2))
        return
    if args in (['sesiones'], ['guardar-sesiones'], ['reanudar-trabajo']):
        action = {'sesiones': 'status', 'guardar-sesiones': 'snapshot', 'reanudar-trabajo': 'recover'}[args[0]]
        os.execve('/usr/bin/python3', ['/usr/bin/python3', str(BASE / 'recovery.py'), action], os.environ.copy())
    if args == ['abrir']:
        for account in PROFILES:
            subprocess.run(['/usr/bin/ptyxis', '--tab', '--title', 'Claude ' + account,
                            '--', '__HOME__/.local/bin/claude-' + account], check=True)
        return
    if args[0] == 'login' and len(args) in (2, 3):
        account = args[1]
        command = [CLAUDE, 'auth', 'login', '--claudeai']
        if len(args) == 3:
            command += ['--email', args[2]]
    elif args[0] in PROFILES:
        account = args[0]
        command = [CLAUDE, *args[1:]]
    else:
        raise SystemExit('Uso inválido. Ejecuta claude-cuentas --help')
    os.execve(CLAUDE, command, environment(account))


if __name__ == '__main__':
    main()
