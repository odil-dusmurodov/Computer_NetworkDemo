#!/usr/bin/env node
'use strict';

// A small WebSocket server using only Node's built-in modules.
// This is intentionally kept readable for a classroom protocol demo.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const START_PORT = Number(process.env.PORT || 8080);
let activePort = START_PORT;
const ROOT = __dirname;
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Map();
const state = {
  count: 0,
  events: 0,
  delivered: 0,
  dropped: 0,
  mode: 'normal',
  outage: false,
};

const httpServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'style.css'].includes(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
  fs.readFile(path.join(ROOT, file), (error, data) => {
    if (error) return res.writeHead(500).end('Could not read demo file');
    res.writeHead(200, { 'Content-Type': types[file], 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function frame(opcode, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendRaw(client, opcode, data) {
  if (!client.socket.destroyed && client.socket.writable) client.socket.write(frame(opcode, data));
}

function send(client, message, immediate = false) {
  if (state.outage && !immediate) return;
  const write = () => {
    if (!client.socket.destroyed && client.socket.writable) sendRaw(client, 0x1, JSON.stringify(message));
  };
  if (!immediate && state.mode === 'delay') setTimeout(write, 900);
  else write();
}

function status() {
  return {
    type: 'status',
    connected: clients.size,
    serverCount: state.count,
    events: state.events,
    delivered: state.delivered,
    dropped: state.dropped,
    mode: state.mode,
    outage: state.outage,
  };
}

function broadcastStatus() {
  const snapshot = status();
  for (const client of clients.values()) send(client, snapshot, true);
}

function fullSnapshot(client) {
  send(client, { ...status(), type: 'snapshot', activity: 'State synchronized' }, true);
}

function removeClient(client) {
  if (!clients.delete(client.socket)) return;
  broadcastStatus();
}

function handle(client, message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'join') {
    const raw = String(message.name || 'Guest').trim();
    client.name = raw.slice(0, 18) || 'Guest';
    fullSnapshot(client);
    broadcastStatus();
    return;
  }
  if (message.type === 'tap') {
    if (!client.name || state.outage) return;
    state.count += 1;
    state.events += 1;
    const event = { type: 'event', name: client.name, text: 'sent a live update' };
    for (const recipient of clients.values()) {
      if (state.mode === 'drop' && Math.random() < 0.33) {
        state.dropped += 1;
        continue;
      }
      state.delivered += 1;
      send(recipient, event);
    }
    broadcastStatus();
    return;
  }
  if (message.type === 'app-ping') {
    send(client, { type: 'app-pong', sentAt: Number(message.sentAt) || Date.now() });
    return;
  }
  if (message.type === 'mode' && ['normal', 'delay', 'drop'].includes(message.mode)) {
    state.mode = message.mode;
    broadcastStatus();
    for (const recipient of clients.values()) send(recipient, { type: 'notice', text: `Mode changed to ${message.mode}` }, true);
    return;
  }
  if (message.type === 'sync') {
    for (const recipient of clients.values()) fullSnapshot(recipient);
    broadcastStatus();
    return;
  }
  if (message.type === 'reset') {
    state.count = state.events = state.delivered = state.dropped = 0;
    for (const recipient of clients.values()) fullSnapshot(recipient);
    broadcastStatus();
    return;
  }
  if (message.type === 'outage' && !state.outage) {
    state.outage = true;
    for (const recipient of clients.values()) {
      send(recipient, { type: 'notice', text: 'Service unavailable for 7 seconds. Clients will retry.' }, true);
      setTimeout(() => {
        if (!recipient.socket.destroyed) sendRaw(recipient, 0x8, Buffer.from([0x03, 0xf4])); // 1012, service restart
        recipient.socket.end();
      }, 120);
    }
    setTimeout(() => {
      state.outage = false;
      console.log('\nSimulated service is back online; reconnecting clients will receive a fresh state snapshot.');
    }, 7000);
  }
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const longLength = client.buffer.readBigUInt64BE(2);
      if (longLength > 1024n * 1024n) return client.socket.destroy();
      length = Number(longLength);
      offset = 10;
    }
    if (!masked || length > 1024 * 1024) return client.socket.destroy();
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 0x8) {
      if (!client.socket.destroyed) sendRaw(client, 0x8, payload.subarray(0, 125));
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendRaw(client, 0x0a, payload);
      continue;
    }
    if (opcode !== 0x1) continue;
    try { handle(client, JSON.parse(payload.toString('utf8'))); }
    catch { send(client, { type: 'error', text: 'Message must be valid JSON.' }, true); }
  }
}

httpServer.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || state.outage) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  const client = { socket, buffer: Buffer.alloc(0), name: '' };
  clients.set(socket, client);
  socket.on('data', chunk => parseFrames(client, chunk));
  socket.on('close', () => removeClient(client));
  socket.on('error', () => removeClient(client));
  broadcastStatus();
});

function printAddresses() {
  console.log(`\nWebSocket Apocalypse demo running on port ${activePort}`);
  console.log(`Open on this computer: http://localhost:${activePort}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) console.log(`Open on phones on the same Wi-Fi: http://${info.address}:${activePort}`);
    }
  }
  console.log('Press Ctrl+C to stop the demo server.');
}

httpServer.on('listening', printAddresses);
httpServer.on('error', error => {
  if (error.code === 'EADDRINUSE' && activePort < START_PORT + 20) {
    const previousPort = activePort;
    activePort += 1;
    console.log(`Port ${previousPort} is already in use; trying ${activePort}…`);
    httpServer.listen(activePort, '0.0.0.0');
    return;
  }
  console.error(`Could not start the demo server: ${error.message}`);
  process.exitCode = 1;
});

httpServer.listen(activePort, '0.0.0.0');
