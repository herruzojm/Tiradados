const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- HTTP Static Server ---

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(PUBLIC, url);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- Session Management ---

const sessions = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (sessions.has(code));
  return code;
}

function rollDice(dice) {
  const results = [];
  const parts = [];
  const order = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

  // Sort dice types for consistent formula display
  const sorted = Object.entries(dice).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  for (const [die, count] of sorted) {
    const sides = die === 'd100' ? 100 : parseInt(die.slice(1));
    parts.push(`${count}${die}`);
    for (let i = 0; i < count; i++) {
      results.push(Math.floor(Math.random() * sides) + 1);
    }
  }

  results.sort((a, b) => b - a);
  return { formula: parts.join(' '), results };
}

function broadcast(session, message, exclude) {
  const data = JSON.stringify(message);
  for (const [ws] of session.players) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function getPlayerNames(session) {
  return Array.from(session.players.values()).map(p => p.name);
}

// --- WebSocket Server ---

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentSession = null;
  let playerName = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'create') {
      const name = (msg.name || '').trim().slice(0, 20);
      if (!name) return ws.send(JSON.stringify({ type: 'error', message: 'Nombre requerido' }));

      const code = generateCode();
      const session = { code, players: new Map(), log: [], timeout: null };
      session.players.set(ws, { name });
      sessions.set(code, session);

      currentSession = session;
      playerName = name;

      ws.send(JSON.stringify({ type: 'created', code }));
      ws.send(JSON.stringify({ type: 'joined', code, players: [name], log: [] }));
    }

    else if (msg.type === 'join') {
      const name = (msg.name || '').trim().slice(0, 20);
      const code = (msg.code || '').toUpperCase().trim();

      if (!name) return ws.send(JSON.stringify({ type: 'error', message: 'Nombre requerido' }));
      if (!code) return ws.send(JSON.stringify({ type: 'error', message: 'Código requerido' }));

      const session = sessions.get(code);
      if (!session) return ws.send(JSON.stringify({ type: 'error', message: 'Sesión no encontrada' }));

      // Check duplicate name
      for (const p of session.players.values()) {
        if (p.name.toLowerCase() === name.toLowerCase()) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Nombre ya en uso en esta sesión' }));
        }
      }

      // Cancel cleanup timeout if exists
      if (session.timeout) {
        clearTimeout(session.timeout);
        session.timeout = null;
      }

      session.players.set(ws, { name });
      currentSession = session;
      playerName = name;

      ws.send(JSON.stringify({
        type: 'joined',
        code,
        players: getPlayerNames(session),
        log: session.log,
      }));

      broadcast(session, { type: 'player-joined', name, players: getPlayerNames(session) }, ws);
    }

    else if (msg.type === 'roll') {
      if (!currentSession) return;

      const validDice = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
      const dice = msg.dice;
      if (!dice || typeof dice !== 'object') return;

      // Validate and cap
      let totalDice = 0;
      const cleanDice = {};
      for (const [die, count] of Object.entries(dice)) {
        if (!validDice.includes(die)) continue;
        const n = Math.min(Math.max(Math.floor(count), 1), 99);
        cleanDice[die] = n;
        totalDice += n;
      }
      if (totalDice === 0 || totalDice > 100) return;

      const { formula, results } = rollDice(cleanDice);
      const entry = { name: playerName, formula, results, timestamp: Date.now() };
      currentSession.log.push(entry);

      // Keep log to last 100 entries
      if (currentSession.log.length > 100) currentSession.log.shift();

      broadcast(currentSession, { type: 'roll-result', ...entry });
    }
  });

  ws.on('close', () => {
    if (!currentSession) return;

    currentSession.players.delete(ws);
    broadcast(currentSession, {
      type: 'player-left',
      name: playerName,
      players: getPlayerNames(currentSession),
    });

    // Clean up empty sessions after 60s
    if (currentSession.players.size === 0) {
      const code = currentSession.code;
      currentSession.timeout = setTimeout(() => {
        sessions.delete(code);
      }, 60000);
    }

    currentSession = null;
    playerName = null;
  });
});

server.listen(PORT, () => {
  console.log(`TiraDados running at http://localhost:${PORT}`);
});
