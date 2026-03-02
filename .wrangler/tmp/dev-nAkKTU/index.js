var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/game-room.js
var GameRoom = class {
  static {
    __name(this, "GameRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.players = /* @__PURE__ */ new Map();
    this.log = [];
    this.initialized = false;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const name = url.searchParams.get("name");
    const code = url.searchParams.get("code");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (action === "create") {
      this.initialized = true;
      this.players.set(server, { name });
      server.send(JSON.stringify({ type: "created", code }));
      server.send(JSON.stringify({
        type: "joined",
        code,
        players: [name],
        log: []
      }));
    } else if (action === "join") {
      if (!this.initialized) {
        server.send(JSON.stringify({ type: "error", message: "Sesion no encontrada" }));
        server.close(4e3, "Session not found");
        return new Response(null, { status: 101, webSocket: client });
      }
      for (const p of this.players.values()) {
        if (p.name.toLowerCase() === name.toLowerCase()) {
          server.send(JSON.stringify({ type: "error", message: "Nombre ya en uso en esta sesion" }));
          server.close(4001, "Name taken");
          return new Response(null, { status: 101, webSocket: client });
        }
      }
      this.players.set(server, { name });
      const playerNames = this.getPlayerNames();
      server.send(JSON.stringify({
        type: "joined",
        code,
        players: playerNames,
        log: this.log
      }));
      this.broadcast({ type: "player-joined", name, players: playerNames }, server);
    }
    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data);
    });
    server.addEventListener("close", () => {
      this.handleClose(server);
    });
    server.addEventListener("error", () => {
      this.handleClose(server);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "roll") return;
    const player = this.players.get(ws);
    if (!player) return;
    const validDice = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];
    const dice = msg.dice;
    if (!dice || typeof dice !== "object") return;
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
    this.broadcast({ type: "roll-result", ...entry });
  }
  handleClose(ws) {
    const player = this.players.get(ws);
    if (!player) return;
    this.players.delete(ws);
    const playerNames = this.getPlayerNames();
    this.broadcast({ type: "player-left", name: player.name, players: playerNames });
    if (this.players.size === 0) {
      this.initialized = false;
      this.log = [];
    }
  }
  rollDice(dice) {
    const results = [];
    const parts = [];
    const order = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];
    const sorted = Object.entries(dice).sort(
      (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
    );
    for (const [die, count] of sorted) {
      const sides = die === "d100" ? 100 : parseInt(die.slice(1));
      parts.push(`${count}${die}`);
      for (let i = 0; i < count; i++) {
        results.push(Math.floor(Math.random() * sides) + 1);
      }
    }
    results.sort((a, b) => b - a);
    return { formula: parts.join(" "), results };
  }
  broadcast(message, exclude) {
    const data = JSON.stringify(message);
    for (const [ws] of this.players) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch {
        }
      }
    }
  }
  getPlayerNames() {
    return Array.from(this.players.values()).map((p) => p.name);
  }
};

// src/index.js
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
__name(generateCode, "generateCode");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const action = url.searchParams.get("action");
      const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
      if (!name) {
        return new Response("Name required", { status: 400 });
      }
      let code;
      if (action === "create") {
        code = generateCode();
        url.searchParams.set("code", code);
      } else if (action === "join") {
        code = (url.searchParams.get("code") || "").toUpperCase().trim();
        if (!code || code.length !== 6) {
          return new Response("Invalid code", { status: 400 });
        }
      } else {
        return new Response("Invalid action", { status: 400 });
      }
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(new Request(url.toString(), request));
    }
    return new Response("Not found", { status: 404 });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-QZwDJ9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-QZwDJ9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GameRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
