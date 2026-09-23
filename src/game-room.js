const TOKEN_COLORS = [
  '#e6394b', '#3aa7ff', '#4cd964', '#ffd700',
  '#b46cff', '#ff8c42', '#00d2c3', '#ff6fc0',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// A network blip drops every player at once and they all reconnect within
// seconds. Keep the room alive long enough for that to be a hiccup instead of
// the end of the session.
const GRACE_MS = 10 * 60 * 1000;

// Dragging emits a position several times a second. Coalesce those into a
// single write instead of hitting storage on every frame.
const MOVE_FLUSH_MS = 3000;

const LOG_LIMIT = 100;
const MAX_TOKENS = 40;
const MAX_BACKGROUND = 800000; // data URL chars; SQLite allows 2 MB per value

// Positions travel as fractions of the map, never pixels: every player has a
// different panel width because of the resizable divider.
function clampPos(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0.02, Math.min(0.98, v));
}

function cleanLabel(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 18);
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.tokensDirty = false;

    // Hibernation re-runs this constructor with empty memory every time the
    // object wakes, so the room is rehydrated from storage before anything
    // else runs. The background is deliberately excluded: it is large and only
    // needed when somebody joins.
    state.blockConcurrencyWhile(async () => {
      const [meta, tokens, playerTokens, log] = await Promise.all([
        state.storage.get('meta'),
        state.storage.get('tokens'),
        state.storage.get('playerTokens'),
        state.storage.get('log'),
      ]);
      this.initialized = meta ? meta.initialized : false;
      this.tokenSeq = meta ? meta.tokenSeq : 0;
      this.npcSeq = meta ? meta.npcSeq : 0;
      this.tokens = new Map(tokens || []);
      this.playerTokens = new Map(playerTokens || []);
      this.log = log || [];
    });

    // The runtime answers keepalive pings itself, so the heartbeat never wakes
    // this object and an idle table can stay hibernated.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const name = url.searchParams.get('name');
    const code = url.searchParams.get('code');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // acceptWebSocket, not accept: this is what lets the object hibernate
    // while the connection stays open on Cloudflare's edge.
    this.state.acceptWebSocket(server);

    if (action === 'create') {
      // Clear anything an abandoned room left behind at this id.
      if (this.others(server).length === 0) await this.reset();

      this.initialized = true;
      server.serializeAttachment({ name });
      this.assignPlayerToken(name);
      await this.state.storage.delete('emptyAt');
      await this.persistMeta();
      await this.persistTokens();

      server.send(JSON.stringify({ type: 'created', code }));
      server.send(JSON.stringify({
        type: 'joined',
        code,
        players: this.playerNames(),
        log: [],
        background: null,
        tokens: this.getTokens(),
      }));

    } else if (action === 'join') {
      if (!this.initialized) {
        // fatal tells the client not to retry; it must not depend on the close
        // code alone, which can be lost.
        server.send(JSON.stringify({ type: 'error', message: 'Sesion no encontrada', fatal: true }));
        server.close(4000, 'Session not found');
        return new Response(null, { status: 101, webSocket: client });
      }

      // A reconnecting player still has their old socket registered here for a
      // few seconds. Replace it rather than rejecting the new one, which used
      // to leave them retrying against their own ghost.
      for (const other of this.others(server)) {
        if ((this.nameOf(other) || '').toLowerCase() === name.toLowerCase()) {
          try {
            other.send(JSON.stringify({
              type: 'error',
              message: 'Te has conectado desde otro sitio con este nombre',
              fatal: true,
            }));
            other.close(4002, 'Replaced by a newer connection');
          } catch {}
        }
      }

      server.serializeAttachment({ name });
      const newToken = this.assignPlayerToken(name);
      await this.state.storage.delete('emptyAt');
      if (newToken) {
        await this.persistMeta();
        await this.persistTokens();
      }

      const playerNames = this.playerNames();
      server.send(JSON.stringify({
        type: 'joined',
        code,
        players: playerNames,
        log: this.log,
        background: (await this.state.storage.get('background')) || null,
        tokens: this.getTokens(),
      }));

      this.broadcast({ type: 'player-joined', name, players: playerNames }, server);
      if (newToken) this.broadcast({ type: 'token-added', token: newToken }, server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernation handlers (these replace the old addEventListener wiring) ---

  async webSocketMessage(ws, raw) {
    const name = this.nameOf(ws);
    if (!name) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'background') {
      // null to clear, or a data URL string.
      if (msg.data !== null && (typeof msg.data !== 'string' || msg.data.length > MAX_BACKGROUND)) return;
      if (msg.data === null) await this.state.storage.delete('background');
      else await this.state.storage.put('background', msg.data);
      this.broadcast({ type: 'background', data: msg.data });
      return;
    }

    if (msg.type === 'token-move') {
      const token = this.tokens.get(msg.id);
      if (!token) return;
      const x = clampPos(msg.x);
      const y = clampPos(msg.y);
      if (x === null || y === null) return;
      token.x = x;
      token.y = y;
      // The mover already drew it locally; echoing back would fight their drag.
      this.broadcast({ type: 'token-moved', id: token.id, x, y }, ws);
      await this.markTokensDirty();
      return;
    }

    if (msg.type === 'token-add') {
      if (this.tokens.size >= MAX_TOKENS) return;
      const color = HEX_RE.test(msg.color) ? msg.color : this.nextColor();
      const label = cleanLabel(msg.label) || 'PNJ ' + (++this.npcSeq);
      const token = this.createToken(label, color, 'npc');
      this.broadcast({ type: 'token-added', token });
      await this.persistMeta();
      await this.persistTokens();
      return;
    }

    if (msg.type === 'token-update') {
      const token = this.tokens.get(msg.id);
      if (!token) return;
      if (typeof msg.color === 'string' && HEX_RE.test(msg.color)) token.color = msg.color;
      const label = cleanLabel(msg.label);
      if (label) token.label = label;
      this.broadcast({ type: 'token-updated', id: token.id, label: token.label, color: token.color });
      await this.persistTokens();
      return;
    }

    if (msg.type === 'token-remove') {
      const token = this.tokens.get(msg.id);
      if (!token) return;
      this.tokens.delete(token.id);
      for (const [key, id] of this.playerTokens) {
        if (id === token.id) this.playerTokens.delete(key);
      }
      this.broadcast({ type: 'token-removed', id: token.id });
      await this.persistTokens();
      return;
    }

    if (msg.type !== 'roll') return;

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
    const entry = { name, formula, results, timestamp: Date.now() };

    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    await this.state.storage.put('log', this.log);

    this.broadcast({ type: 'roll-result', ...entry });
  }

  async webSocketClose(ws, code, reason) {
    await this.handleDeparture(ws);
    // The runtime hands us the peer's close frame but does not answer it. Until
    // we close our side the peer stays in CLOSING and never fires 'close'.
    // 1005/1006 are receive-only codes and cannot be sent back.
    const echo = code >= 3000 && code <= 4999 ? code : 1000;
    try { ws.close(echo, reason || ''); } catch {}
  }

  async webSocketError(ws) {
    await this.handleDeparture(ws);
  }

  async handleDeparture(ws) {
    const name = this.nameOf(ws);
    if (!name) return;

    // getWebSockets() can still include the socket that is going away.
    const remaining = this.others(ws);
    this.broadcast(
      { type: 'player-left', name, players: remaining.map(s => this.nameOf(s)).filter(Boolean) },
      ws
    );

    if (this.tokensDirty) await this.persistTokens();

    if (remaining.length === 0) {
      // Do not wipe the room now: start the grace clock instead.
      await this.state.storage.put('emptyAt', Date.now());
      await this.scheduleAlarm(Date.now() + GRACE_MS);
    }
  }

  async alarm() {
    if (this.tokensDirty) await this.persistTokens();

    if (this.state.getWebSockets().length > 0) return;

    const emptyAt = await this.state.storage.get('emptyAt');
    if (!emptyAt) return;

    if (Date.now() - emptyAt >= GRACE_MS) {
      await this.reset();
    } else {
      await this.state.storage.setAlarm(emptyAt + GRACE_MS);
    }
  }

  // --- Persistence ---

  async persistMeta() {
    await this.state.storage.put('meta', {
      initialized: this.initialized,
      tokenSeq: this.tokenSeq,
      npcSeq: this.npcSeq,
    });
  }

  async persistTokens() {
    this.tokensDirty = false;
    await this.state.storage.put({
      tokens: Array.from(this.tokens),
      playerTokens: Array.from(this.playerTokens),
    });
  }

  async markTokensDirty() {
    this.tokensDirty = true;
    await this.scheduleAlarm(Date.now() + MOVE_FLUSH_MS);
  }

  // A Durable Object has a single alarm, shared here between the debounced
  // token flush and the grace timer. Never push an earlier one back.
  async scheduleAlarm(at) {
    const current = await this.state.storage.getAlarm();
    if (current === null || at < current) await this.state.storage.setAlarm(at);
  }

  async reset() {
    this.initialized = false;
    this.tokens.clear();
    this.playerTokens.clear();
    this.log = [];
    this.tokenSeq = 0;
    this.npcSeq = 0;
    this.tokensDirty = false;
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  // --- Connected players, derived from the sockets rather than from memory ---

  others(exclude) {
    return this.state.getWebSockets().filter(ws => ws !== exclude);
  }

  nameOf(ws) {
    try {
      const attachment = ws.deserializeAttachment();
      return attachment && attachment.name ? attachment.name : null;
    } catch {
      return null;
    }
  }

  playerNames() {
    return this.state.getWebSockets().map(ws => this.nameOf(ws)).filter(Boolean);
  }

  // --- Tokens ---

  nextColor() {
    const used = new Set(Array.from(this.tokens.values()).map(t => t.color));
    const free = TOKEN_COLORS.find(c => !used.has(c));
    return free || TOKEN_COLORS[this.tokens.size % TOKEN_COLORS.length];
  }

  createToken(label, color, kind) {
    // Stagger new tokens across a row so they never land exactly on each other.
    const slot = this.tokens.size % 8;
    const token = {
      id: 't' + (++this.tokenSeq),
      label,
      color,
      kind,
      x: 0.12 + slot * 0.105,
      y: kind === 'player' ? 0.88 : 0.5,
    };
    this.tokens.set(token.id, token);
    return token;
  }

  assignPlayerToken(name) {
    const key = name.toLowerCase();
    const existing = this.playerTokens.get(key);
    if (existing && this.tokens.has(existing)) return null;
    const token = this.createToken(name, this.nextColor(), 'player');
    this.playerTokens.set(key, token.id);
    return token;
  }

  getTokens() {
    return Array.from(this.tokens.values());
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
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(data); } catch {}
    }
  }
}
