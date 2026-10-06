'use strict';

const $ = id => document.getElementById(id);
const ui = {
  joinPanel: $('joinPanel'), room: $('room'), joinForm: $('joinForm'), nameInput: $('nameInput'),
  connectionDot: $('connectionDot'), connectionText: $('connectionText'), tapButton: $('tapButton'),
  connected: $('connectedCount'), local: $('localCount'), server: $('serverCount'), rtt: $('rtt'),
  events: $('eventCount'), delivered: $('deliveredCount'), dropped: $('droppedCount'), feed: $('feed'),
  notice: $('notice'), modeBadge: $('modeBadge'), outageButton: $('outageButton'),
};

let ws = null;
let joined = false;
let reconnectTimer = null;
let retryCount = 0;
let localCount = 0;
let pingTimer = null;
let lastMode = 'normal';

function setConnection(kind, text) {
  ui.connectionDot.className = `dot ${kind}`;
  ui.connectionText.textContent = text;
  $('transportLabel').textContent = kind === 'online' ? 'WebSocket · connected' : text;
  ui.tapButton.disabled = kind !== 'online';
}

function say(text) { ui.notice.textContent = text; }

function addFeed(text, tone = '') {
  const empty = ui.feed.querySelector('.empty-feed');
  if (empty) empty.remove();
  const item = document.createElement('li');
  if (tone) item.style.borderLeftColor = tone;
  const time = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.append(time, document.createTextNode(text));
  ui.feed.prepend(item);
  while (ui.feed.children.length > 14) ui.feed.lastElementChild.remove();
}

function setLocalCount(value) {
  localCount = value;
  ui.local.textContent = String(localCount);
  ui.local.style.color = localCount === Number(ui.server.textContent) ? 'var(--green)' : 'var(--amber)';
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function updateStatus(message) {
  ui.connected.textContent = String(message.connected ?? 0);
  ui.server.textContent = String(message.serverCount ?? 0);
  ui.events.textContent = String(message.events ?? 0);
  ui.delivered.textContent = String(message.delivered ?? 0);
  ui.dropped.textContent = String(message.dropped ?? 0);
  const mode = message.mode || 'normal';
  if (mode !== lastMode) {
    document.querySelectorAll('.control-button').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
    ui.modeBadge.textContent = mode === 'drop' ? 'APP DROP' : mode.toUpperCase();
    ui.modeBadge.className = `mode-badge${mode === 'normal' ? '' : ` ${mode}`}`;
    lastMode = mode;
  }
}

function scheduleReconnect() {
  if (!joined || reconnectTimer) return;
  const delay = Math.min(1000 * (2 ** retryCount), 5000) + Math.floor(Math.random() * 350);
  retryCount += 1;
  say(`Reconnecting in about ${(delay / 1000).toFixed(1)} seconds…`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function connect() {
  if (!joined || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  setConnection('retry', 'Connecting…');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${scheme}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    retryCount = 0;
    setConnection('online', 'Connected');
    send({ type: 'join', name: ui.nameInput.value.trim() || 'Guest' });
    say('Connected. Your client is ready to receive live updates.');
    addFeed('WebSocket connection established', 'var(--teal)');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'app-ping', sentAt: Date.now() }), 2500);
  });
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'status') updateStatus(message);
    if (message.type === 'snapshot') {
      updateStatus(message);
      setLocalCount(Number(message.serverCount) || 0);
      addFeed(message.activity || 'State synchronized', 'var(--teal)');
    }
    if (message.type === 'event') {
      setLocalCount(localCount + 1);
      addFeed(`${message.name} ${message.text}`);
    }
    if (message.type === 'app-pong') ui.rtt.textContent = String(Math.max(0, Date.now() - message.sentAt));
    if (message.type === 'notice') { say(message.text); addFeed(message.text, 'var(--amber)'); }
    if (message.type === 'error') say(message.text);
  });
  ws.addEventListener('close', () => {
    clearInterval(pingTimer);
    if (!joined) return;
    setConnection('retry', 'Reconnecting');
    scheduleReconnect();
  });
  ws.addEventListener('error', () => setConnection('retry', 'Connection problem'));
}

ui.joinForm.addEventListener('submit', event => {
  event.preventDefault();
  joined = true;
  ui.joinPanel.classList.add('hidden');
  ui.room.classList.remove('hidden');
  connect();
});

ui.tapButton.addEventListener('click', () => send({ type: 'tap' }));
document.querySelectorAll('.control-button').forEach(button => button.addEventListener('click', () => send({ type: 'mode', mode: button.dataset.mode })));
$('syncButton').addEventListener('click', () => send({ type: 'sync' }));
ui.outageButton.addEventListener('click', () => {
  send({ type: 'outage' });
  say('Outage simulation started. Watch clients reconnect and synchronize.');
});
window.addEventListener('beforeunload', () => { joined = false; clearTimeout(reconnectTimer); clearInterval(pingTimer); });
