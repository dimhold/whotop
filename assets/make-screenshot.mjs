/**
 * Draw the interactive screen into an SVG, through the real rendering code.
 *
 *   node assets/make-screenshot.mjs > assets/screen.svg
 *
 * The frame is produced by the same functions the terminal gets, so the
 * picture in the README cannot drift away from what the program does. A
 * screenshot taken by hand can, and usually does, the week after a redesign.
 *
 * The processes are invented rather than captured. A real machine puts real
 * user names and real project paths into every row, and those do not belong in
 * a public repository. Everything about their shape is true to life: the six
 * indistinguishable node processes, the orphan holding a port, the service that
 * discloses nothing but its name.
 */
import { renderRow, renderFooter, withVersion, initialState, clampVisible, PANE_HEIGHT } from '../dist/tui.js';
import { renderDetail } from '../dist/render.js';
import { createPalette } from '../dist/color.js';
import { exact, inferred, unavailable } from '../dist/types.js';
import { readFileSync } from 'node:fs';

/**
 * Read, not typed in. The stamp said v0.1.0 for the whole of 0.2.0, because a
 * number written down in a generator is a number nobody remembers to change.
 * It comes from the same package.json the CLI reads, so the picture and
 * `whotop version` cannot disagree.
 */
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const COLS = 104;
const CELL_W = 8.42;
const CELL_H = 19;
const PAD_X = 26;
const PAD_Y = 62;
const CHROME = 40;

const ANSI_TO_HEX = {
  '0': null,
  '1': '#f0f6fc',
  '2': '#6e7681',
  '3': '#8b949e',
  '4': '#8b949e',
  '7': 'INVERSE',
  '31': '#ff7b72',
  '32': '#7ee787',
  '33': '#e3b341',
  '34': '#79c0ff',
  '35': '#d2a8ff',
  '36': '#76e3ea',
  '90': '#8b949e',
  '91': '#ffa198',
  '92': '#56d364',
  '93': '#e3b341',
  '97': '#f0f6fc',
};

const port = (n, state = 'listen') => ({ protocol: 'tcp', address: '::', port: n, state, pid: 0 });

/** Fixed, so the picture is byte for byte the same on every run. */
const NOW = new Date('2026-08-19T21:47:02Z');

const proc = (over) => ({
  pid: 1000,
  ppid: 900,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: new Date(NOW.getTime() - (over.ageMs ?? 3 * 3_600_000)),
  user: null,
  services: [],
  classification: { role: 'dev-server', confidence: 0.8, reason: 'vite', matches: [], label: 'vite' },
  ports: [],
  orphan: exact(false),
  ageMs: 3 * 3_600_000,
  project: exact('shop-web'),
  ...over,
});

const PROCESSES = [
  proc({
    pid: 14208,
    classification: { role: 'agent-session', confidence: 0.95, reason: 'the executable itself is an agent CLI (claude.exe)', matches: [], label: 'claude' },
    name: 'claude.exe',
    commandLine: exact('C:\\Users\\dev\\.local\\bin\\claude.exe --resume'),
    cwd: inferred('C:\\Users\\dev\\projects\\api-gateway', 'matched to C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\C--Users-dev-projects-api-gateway, created 1.4s from this process start (claude session 8f3c1a90); a time correlation inside a 45s window, not a reading of the process'),
    project: inferred('api-gateway', 'from the working directory the trace pointed at'),
    ageMs: 5 * 3_600_000,
  }),
  proc({
    pid: 9120,
    ports: [port(4310)],
    commandLine: exact('"node" "C:\\Users\\dev\\projects\\shop-web\\node_modules\\vite\\bin\\vite.js" dev --port 4310'),
    cwd: inferred('C:\\Users\\dev\\projects\\shop-web', 'from the command line'),
    ageMs: 2 * 3_600_000 + 17 * 60_000,
  }),
  proc({
    pid: 11544,
    ports: [port(4311)],
    orphan: exact(true),
    commandLine: exact('"node" "C:\\Users\\dev\\projects\\admin-ui\\node_modules\\vite\\bin\\vite.js" dev --port 4311'),
    cwd: inferred('C:\\Users\\dev\\projects\\admin-ui', 'from the command line'),
    project: exact('admin-ui'),
    ageMs: 19 * 3_600_000,
  }),
  proc({
    pid: 6552,
    name: 'node.exe',
    classification: { role: 'mcp-server', confidence: 0.9, reason: '@modelcontextprotocol in the arguments', matches: [], label: 'chrome-devtools-mcp' },
    commandLine: exact('"node" "chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js"'),
    project: unavailable('outside a package'),
    ageMs: 19 * 3_600_000,
  }),
  proc({
    pid: 8248,
    classification: { role: 'test-runner', confidence: 0.85, reason: 'vitest in the command line', matches: [], label: 'vitest' },
    commandLine: exact('"node" "node_modules\\vitest\\vitest.mjs" --watch'),
    ageMs: 41 * 60_000,
  }),
  proc({
    pid: 7528,
    name: 'postgres.exe',
    classification: { role: 'database', confidence: 0.99, reason: 'postgres', matches: [], label: 'postgres' },
    ports: [port(5432)],
    commandLine: unavailable('Win32_Process withheld the command line'),
    cwd: unavailable('withheld'),
    project: unavailable('withheld'),
    ageMs: 19 * 3_600_000,
  }),
  proc({
    pid: 5684,
    name: 'svchost.exe',
    classification: { role: 'unknown', confidence: 0, reason: 'no rule matched', matches: [], label: null },
    services: ['WireGuardTunnel$Poland-2'],
    commandLine: unavailable('Win32_Process withheld the command line for this process'),
    cwd: unavailable('withheld'),
    project: unavailable('withheld'),
    ageMs: 19 * 3_600_000,
  }),
  proc({
    pid: 5512,
    name: 'svchost.exe',
    classification: { role: 'unknown', confidence: 0, reason: 'no rule matched', matches: [], label: null },
    services: ['CloudflareWARP'],
    commandLine: unavailable('Win32_Process withheld the command line for this process'),
    cwd: unavailable('withheld'),
    project: unavailable('withheld'),
    ageMs: 19 * 3_600_000,
  }),
];

const palette = createPalette(true);
// The orphan holding 4311 is the default story. WHOTOP_SELECTED picks another
// row so one generator can draw more than one frame.
const SELECTED = Number(process.env.WHOTOP_SELECTED ?? 2);

// Taken from the program rather than written down here. The pane grew from
// eight lines to twelve once, and this file kept drawing eight, which is
// exactly the drift it was written to prevent.
const paneFor = (view, width) => {
  const rule = palette('gray', ' ' + '─'.repeat(width - 2));
  const body = PANE_HEIGHT - 1;
  const full = renderDetail(view, { width, palette, wide: false });
  if (full.length <= body) return [rule, ...full, ...Array.from({ length: body - full.length }, () => '')];
  return [rule, ...full.slice(0, body - 1), palette('cyan', `  … ${full.length - body + 1} more lines, press d for the full view`)];
};

// Tall enough for the header, every process below, the pane and the footer,
// and no taller. A real terminal leaves blank rows under a short list; a
// picture that reproduced them would spend half its height on nothing.
const listHeight = PROCESSES.length;
const ROWS = 2 + listHeight + PANE_HEIGHT;
const lines = [
  palette('bold', ` whotop  win32  ${PROCESSES.length} of 443 processes  21:47:02`),
  ...PROCESSES.slice(0, listHeight).map((view, i) => renderRow(view, COLS, i === SELECTED, palette, 'what')),
  ...Array.from({ length: Math.max(0, listHeight - PROCESSES.length) }, () => ''),
  ...paneFor(PROCESSES[SELECTED], COLS),
  withVersion(renderFooter({ ...initialState(false, 'role'), selected: PROCESSES[SELECTED].pid }, PROCESSES.length, palette), VERSION, COLS, palette),
].map((line) => clampVisible(line, COLS));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Split one rendered line into coloured runs, so each becomes a tspan. */
function runs(line) {
  const out = [];
  let fill = '#e6edf3';
  let bold = false;
  let inverse = false;
  let text = '';
  const push = () => {
    if (text !== '') out.push({ text, fill, bold, inverse });
    text = '';
  };
  for (let i = 0; i < line.length; ) {
    const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (m) {
      push();
      for (const code of (m[1] || '0').split(';')) {
        const hex = ANSI_TO_HEX[code];
        if (code === '0') {
          fill = '#e6edf3';
          bold = false;
          inverse = false;
        } else if (hex === 'INVERSE') inverse = true;
        else if (code === '1') bold = true;
        else if (hex) fill = hex;
      }
      i += m[0].length;
      continue;
    }
    text += line[i];
    i += 1;
  }
  push();
  return out;
}

const W = Math.round(PAD_X * 2 + COLS * CELL_W);
const H = Math.round(PAD_Y + ROWS * CELL_H + 22);
const parts = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace, 'DejaVu Sans Mono', 'Cascadia Code', Consolas, 'Courier New', monospace" font-size="14">`,
  `<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="#0d1117"/>`,
  `<rect x="0" y="0" width="${W}" height="${CHROME}" rx="12" fill="#161b22"/>`,
  `<rect x="0" y="24" width="${W}" height="16" fill="#161b22"/>`,
  `<circle cx="24" cy="20" r="6" fill="#ff5f56"/><circle cx="44" cy="20" r="6" fill="#ffbd2e"/><circle cx="64" cy="20" r="6" fill="#27c93f"/>`,
  `<text x="${W / 2}" y="25" text-anchor="middle" fill="#8b949e" font-size="13">dev@laptop: whotop</text>`,
];

lines.forEach((line, row) => {
  const y = PAD_Y + row * CELL_H;
  const segments = runs(line);
  if (segments.some((s) => s.inverse)) {
    parts.push(`<rect x="${PAD_X - 4}" y="${y - 14}" width="${COLS * CELL_W + 8}" height="${CELL_H}" fill="#1f6feb" opacity="0.35"/>`);
  }
  let col = 0;
  const spans = segments.map((s) => {
    const x = PAD_X + col * CELL_W;
    col += s.text.length;
    const weight = s.bold ? ' font-weight="700"' : '';
    const fill = s.inverse ? '#f0f6fc' : s.fill;
    return `<tspan x="${x.toFixed(1)}" fill="${fill}"${weight} xml:space="preserve">${esc(s.text)}</tspan>`;
  });
  if (spans.length > 0) parts.push(`<text y="${y.toFixed(1)}">${spans.join('')}</text>`);
});

parts.push('</svg>');

/**
 * `--json` emits the same frame as coloured runs, so a raster renderer can
 * draw exactly what the SVG draws. One frame, two outputs, and no chance of a
 * PNG in a post disagreeing with the SVG in the README.
 */
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ cols: COLS, lines: lines.map(runs) }) + '\n');
} else {
  process.stdout.write(parts.join('\n') + '\n');
}
