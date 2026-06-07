#!/usr/bin/env node
/*
 * coclaude-pit MCP server — lets a Claude session OPERATE the cockpit.
 * Launched per-session by the cockpit's Claude templates via --mcp-config.
 * It connects to the daemon over the same local WS the GUI uses (token from
 * ~/.coclaude-pit/daemon.json) and exposes cockpit_* tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');

class DaemonClient {
  constructor() { this.ws = null; this.waiters = new Set(); this.ready = null; }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let d;
      try { d = JSON.parse(readFileSync(DAEMON_FILE, 'utf8')); }
      catch { reject(new Error('coclaude-pit daemon not running (no daemon.json)')); return; }
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
      this.ws = ws;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: d.token })));
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'hello-ok') resolve(this);
        for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.delete(w); clearTimeout(w.timer); w.resolve(m); }
      });
      ws.on('error', (e) => reject(e));
      ws.on('close', () => { this.ready = null; });
    });
    return this.ready;
  }
  async send(o) { await this.connect(); this.ws.send(JSON.stringify(o)); }
  async request(msg, pred, timeout = 8000) {
    await this.connect();
    const p = new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error('daemon response timeout')); }, timeout);
      this.waiters.add(w);
    });
    this.ws.send(JSON.stringify(msg));
    return p;
  }
}

const daemon = new DaemonClient();
const ok = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (m) => ({ content: [{ type: 'text', text: 'error: ' + m }], isError: true });
const guard = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(e.message || String(e)); } };

const server = new McpServer({ name: 'coclaude-pit', version: '0.0.1' });

server.registerTool('cockpit_list_sessions',
  { title: 'List sessions', description: 'List cockpit sessions (tabs) with Claude state + island, plus the islands.', inputSchema: {} },
  guard(async () => { const m = await daemon.request({ type: 'list' }, (x) => x.type === 'sessions'); return ok({ sessions: m.sessions, islands: m.islands }); }));

server.registerTool('cockpit_spawn_session',
  { title: 'Spawn session', description: 'Open a new session/tab. Optional name, cwd, color (hex), shell, island id.',
    inputSchema: { name: z.string().optional(), cwd: z.string().optional(), color: z.string().optional(), shell: z.string().optional(), island: z.string().optional() } },
  guard(async (a) => { const m = await daemon.request({ type: 'spawn', ...a }, (x) => x.type === 'spawned'); return ok({ id: m.id, meta: m.meta }); }));

server.registerTool('cockpit_send_text',
  { title: 'Send text to a session', description: 'Type text into a session; enter=true submits it (runs the command). Use deliberately — this executes in a live shell.',
    inputSchema: { id: z.string(), text: z.string(), enter: z.boolean().optional() } },
  guard(async ({ id, text, enter }) => { await daemon.send({ type: 'input', id, data: text + (enter ? '\r' : '') }); return ok('sent'); }));

server.registerTool('cockpit_read_buffer',
  { title: 'Read a session buffer', description: 'Read recent terminal output of a session (default last 4000 chars).',
    inputSchema: { id: z.string(), bytes: z.number().optional() } },
  guard(async ({ id, bytes }) => { const m = await daemon.request({ type: 'read-buffer', id, bytes: bytes || 4000 }, (x) => x.type === 'buffer' && x.id === id); return m.found ? ok(m.data) : fail('no such session'); }));

server.registerTool('cockpit_rename_tab',
  { title: 'Rename / recolor a tab', description: 'Set a session tab name and/or color (hex, or null to clear).',
    inputSchema: { id: z.string(), name: z.string().optional(), color: z.string().nullable().optional() } },
  guard(async ({ id, name, color }) => { const msg = { type: 'rename', id }; if (name !== undefined) msg.name = name; if (color !== undefined) msg.color = color; await daemon.send(msg); return ok('renamed'); }));

server.registerTool('cockpit_close_session',
  { title: 'Close a session', description: 'Kill a session/tab and its shell process.', inputSchema: { id: z.string() } },
  guard(async ({ id }) => { await daemon.send({ type: 'kill', id }); return ok('closed'); }));

server.registerTool('cockpit_create_island',
  { title: 'Create island', description: 'Create a tab island (group). Optional name + color.',
    inputSchema: { name: z.string().optional(), color: z.string().optional() } },
  guard(async (a) => { const m = await daemon.request({ type: 'island-create', ...a }, (x) => x.type === 'island-created'); return ok({ id: m.id }); }));

server.registerTool('cockpit_set_island',
  { title: 'Update island', description: 'Rename / recolor / collapse an island.',
    inputSchema: { id: z.string(), name: z.string().optional(), color: z.string().nullable().optional(), collapsed: z.boolean().optional() } },
  guard(async (a) => { await daemon.send({ type: 'island-update', ...a }); return ok('updated'); }));

server.registerTool('cockpit_move_session',
  { title: 'Move session to island', description: 'Assign a session to an island id, or null to ungroup.',
    inputSchema: { id: z.string(), island: z.string().nullable() } },
  guard(async ({ id, island }) => { await daemon.send({ type: 'session-move', id, island }); return ok('moved'); }));

server.registerTool('cockpit_notify',
  { title: 'Notify Filipe', description: 'Send Filipe a desktop notification through the cockpit (e.g. a session needs attention or finished).',
    inputSchema: { message: z.string(), level: z.enum(['info', 'warn', 'success']).optional(), sessionId: z.string().optional() } },
  guard(async (a) => { await daemon.send({ type: 'notify', ...a }); return ok('notified'); }));

await server.connect(new StdioServerTransport());
