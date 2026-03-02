export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.players = new Map(); // ws -> { name }
    this.log = [];
    this.initialized = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const name = url.searchParams.get('name');
    const code = url.searchParams.get('code');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (action === 'create') {
      this.initialized = true;
      this.players.set(server, { name });

      server.send(JSON.stringify({ type: 'created', code }));
      server.send(JSON.stringify({
        type: 'joined',
        code,
        players: [name],
        log: [],
      }));

    } else if (action === 'join') {
      if (!this.initialized) {
        server.send(JSON.stringify({ type: 'error', message: 'Sesion no encontrada' }));
        server.close(4000, 'Session not found');
        return new Response(null, { status: 101, webSocket: client });
      }

      for (const p of this.players.values()) {
        if (p.name.toLowerCase() === name.toLowerCase()) {
          server.send(JSON.stringify({ type: 'error', message: 'Nombre ya en uso en esta sesion' }));
          server.close(4001, 'Name taken');
          return new Response(null, { status: 101, webSocket: client });
        }
      }

      this.players.set(server, { name });
      const playerNames = this.getPlayerNames();

      server.send(JSON.stringify({
        type: 'joined',
        code,
        players: playerNames,
        log: this.log,
      }));

      this.broadcast({ type: 'player-joined', name, players: playerNames }, server);
    }

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data);
    });

    server.addEventListener('close', () => {
      this.handleClose(server);
    });

    server.addEventListener('error', () => {
      this.handleClose(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== 'roll') return;

    const player = this.players.get(ws);
    if (!player) return;

    const validDice = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
    const dice = msg.dice;
    if (!dice || typeof dice !== 'object') return;

    let totalDice = 0;
    const cleanDice = {};
    for (const [die, count] of Object.entries(dice)) {
      if (!validDice.includes(die)) continue;
      const n = Math.min(Math.max(Math.floor(count), 1), 99);
      cleanDice[die] = n;
      totalDice += n;
    }
    if (totalDice === 0 || totalDice > 100) return;

    const { formula, results } = this.rollDice(cleanDice);
    const entry = { name: player.name, formula, results, timestamp: Date.now() };

    this.log.push(entry);
    if (this.log.length > 100) this.log.shift();

    this.broadcast({ type: 'roll-result', ...entry });
  }

  handleClose(ws) {
    const player = this.players.get(ws);
    if (!player) return;

    this.players.delete(ws);
    const playerNames = this.getPlayerNames();
    this.broadcast({ type: 'player-left', name: player.name, players: playerNames });

    if (this.players.size === 0) {
      this.initialized = false;
      this.log = [];
    }
  }

  rollDice(dice) {
    const results = [];
    const parts = [];
    const order = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
    const sorted = Object.entries(dice).sort(
      (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
    );

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

  broadcast(message, exclude) {
    const data = JSON.stringify(message);
    for (const [ws] of this.players) {
      if (ws !== exclude) {
        try { ws.send(data); } catch {}
      }
    }
  }

  getPlayerNames() {
    return Array.from(this.players.values()).map(p => p.name);
  }
}
