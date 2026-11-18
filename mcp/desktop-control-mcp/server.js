#!/usr/bin/env node
/*
 * desktop-control-mcp — servidor MCP sin dependencias para control de escritorio en X11.
 * Envuelve xdotool (mouse/teclado) y scrot (captura). Diseñado para auditarse de un vistazo.
 *
 * Requiere una sesión X11 (DISPLAY). En Wayland NO funciona (GNOME bloquea input/captura).
 * Transporte: JSON-RPC 2.0 sobre stdio, mensajes delimitados por newline (transporte stdio de MCP).
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Asegura un DISPLAY si Claude Code se lanzó sin él (asume :0, el display de la sesión X11).
if (!process.env.DISPLAY) process.env.DISPLAY = ':0';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'desktop-control', version: '1.0.0' };

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim();
}

function xdotool(args) {
  return run('xdotool', args);
}

// --- implementación de cada herramienta ---

function screenshot() {
  const file = path.join(os.tmpdir(), `mcp-shot-${process.pid}-${Date.now()}.png`);
  try {
    run('scrot', ['-o', '-q', '85', file]); // -o sobreescribe, -q calidad
    const data = fs.readFileSync(file).toString('base64');
    return { type: 'image', data, mimeType: 'image/png' };
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function screenSize() {
  const out = xdotool(['getdisplaygeometry']); // "W H"
  const [w, h] = out.split(/\s+/).map(Number);
  return { width: w, height: h };
}

function cursorLocation() {
  const out = xdotool(['getmouselocation', '--shell']); // X=.. Y=.. ...
  const m = Object.fromEntries(out.split('\n').map((l) => l.split('=')));
  return { x: Number(m.X), y: Number(m.Y) };
}

const BUTTON = { left: '1', middle: '2', right: '3' };

// --- registro de herramientas (schema + handler) ---

const TOOLS = [
  {
    name: 'screenshot',
    description: 'Captura toda la pantalla y la devuelve como imagen PNG. Úsalo para VER el estado actual del escritorio antes de actuar.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [screenshot()] }),
  },
  {
    name: 'get_screen_size',
    description: 'Devuelve el ancho y alto de la pantalla en píxeles.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: JSON.stringify(screenSize()) }] }),
  },
  {
    name: 'get_cursor_position',
    description: 'Devuelve la posición actual del cursor (x, y).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: JSON.stringify(cursorLocation()) }] }),
  },
  {
    name: 'move_mouse',
    description: 'Mueve el cursor a la coordenada absoluta (x, y).',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
    handler: ({ x, y }) => {
      xdotool(['mousemove', String(x | 0), String(y | 0)]);
      return { content: [{ type: 'text', text: `mouse en ${x | 0},${y | 0}` }] };
    },
  },
  {
    name: 'click',
    description: 'Hace click. Si se dan x,y mueve el cursor allí primero. button: left|right|middle (default left). count: número de clicks (2 = doble click).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'number' },
      },
    },
    handler: ({ x, y, button = 'left', count = 1 }) => {
      const args = [];
      if (x !== undefined && y !== undefined) args.push('mousemove', String(x | 0), String(y | 0));
      args.push('click', '--repeat', String(count | 0 || 1), BUTTON[button] || '1');
      xdotool(args);
      return { content: [{ type: 'text', text: `click ${button} x${count} en ${x ?? '?'},${y ?? '?'}` }] };
    },
  },
  {
    name: 'drag',
    description: 'Arrastra con el botón izquierdo desde (x1,y1) hasta (x2,y2).',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' }, y1: { type: 'number' },
        x2: { type: 'number' }, y2: { type: 'number' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    handler: ({ x1, y1, x2, y2 }) => {
      xdotool(['mousemove', String(x1 | 0), String(y1 | 0), 'mousedown', '1',
        'mousemove', String(x2 | 0), String(y2 | 0), 'mouseup', '1']);
      return { content: [{ type: 'text', text: `drag ${x1},${y1} -> ${x2},${y2}` }] };
    },
  },
  {
    name: 'scroll',
    description: 'Hace scroll vertical. amount positivo = abajo, negativo = arriba (número de "muescas").',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
    },
    handler: ({ amount }) => {
      const btn = amount >= 0 ? '5' : '4'; // 5 = abajo, 4 = arriba
      xdotool(['click', '--repeat', String(Math.abs(amount | 0) || 1), btn]);
      return { content: [{ type: 'text', text: `scroll ${amount}` }] };
    },
  },
  {
    name: 'type_text',
    description: 'Escribe texto literal en la ventana enfocada.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: ({ text }) => {
      xdotool(['type', '--delay', '15', '--', text]);
      return { content: [{ type: 'text', text: `escrito ${text.length} chars` }] };
    },
  },
  {
    name: 'press_key',
    description: 'Pulsa una tecla o combinación estilo xdotool, p.ej. "Return", "ctrl+c", "alt+Tab", "super".',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' } },
      required: ['keys'],
    },
    handler: ({ keys }) => {
      xdotool(['key', '--', keys]);
      return { content: [{ type: 'text', text: `tecla ${keys}` }] };
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// --- bucle JSON-RPC sobre stdio (newline-delimited) ---

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleRequest(req) {
  const { id, method, params } = req;
  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        } };
      case 'tools/call': {
        const tool = TOOL_MAP[params?.name];
        if (!tool) throw new Error(`herramienta desconocida: ${params?.name}`);
        const result = tool.handler(params.arguments || {});
        return { jsonrpc: '2.0', id, result };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        // notificaciones (notifications/initialized, etc.) no llevan id ni respuesta
        if (id === undefined) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `método no soportado: ${method}` } };
    }
  } catch (err) {
    if (id === undefined) return null;
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: `ERROR: ${err.message}` }],
      isError: true,
    } };
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const res = handleRequest(req);
    if (res) send(res);
  }
});
process.stdin.on('end', () => process.exit(0));
