(function () {
  // --- Identity and room code ---
  // The name must not live in the URL. With it there, sharing the address bar
  // made the recipient join under the sharer's name -- and since a repeated
  // name now replaces the older connection, that kicked the sharer out of
  // their own room. It rides in sessionStorage instead: per tab, so two tabs
  // can be two players, and it survives a reload.
  const NAME_KEY = 'tiradados-name';
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code'); // null if creating

  function storageWorks() {
    try {
      sessionStorage.setItem('__probe', '1');
      sessionStorage.removeItem('__probe');
      return true;
    } catch {
      return false;
    }
  }

  const hasStorage = storageWorks();
  // A name in the query string is only honoured when storage is unavailable.
  // Otherwise it is ignored and stripped, so old shared links cannot hijack
  // anyone: the visitor is simply sent to the join form to name themselves.
  const name = hasStorage
    ? sessionStorage.getItem(NAME_KEY)
    : params.get('name');

  // Only strip it when storage is carrying the name instead; without storage
  // the query string is the only copy and a reload would lose it.
  if (hasStorage && params.has('name')) {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('name');
    window.history.replaceState(null, '', clean.toString());
  }

  if (!name) {
    window.location.href = code ? '/?code=' + encodeURIComponent(code) : '/';
    return;
  }

  if (hasStorage) sessionStorage.setItem(NAME_KEY, name);

  // --- DOM refs ---
  const codeEl = document.getElementById('session-code');
  const playerListEl = document.getElementById('player-list');
  const selectorEl = document.getElementById('dice-selector');
  const stagingEl = document.getElementById('dice-staging');
  const diceTray = document.getElementById('dice-tray');
  const tokenLayer = document.getElementById('token-layer');
  const tokenPalette = document.getElementById('token-palette');
  const btnClear = document.getElementById('btn-clear');
  const btnRoll = document.getElementById('btn-roll');
  const btnRollHidden = document.getElementById('btn-roll-hidden');
  const logEntries = document.getElementById('log-entries');
  const logEmpty = document.getElementById('log-empty');
  const banner = document.getElementById('connection-banner');

  const PING_INTERVAL_MS = 25000;
  const PONG_TIMEOUT_MS = 10000;

  // --- State ---
  let selectedDice = [];
  let ws = null;
  let sessionCode = code;
  let reconnectDelay = 1000;
  let pingTimer = null;
  let rejected = false;
  let pongTimer = null;

  // --- Render dice selector ---
  DiceSVG.types.forEach(type => {
    const btn = document.createElement('div');
    btn.className = 'die-btn';
    btn.innerHTML = DiceSVG.render(type, 52);
    btn.title = type;
    btn.addEventListener('click', () => addDie(type));
    selectorEl.appendChild(btn);
  });

  // --- Dice staging ---
  function addDie(type) {
    selectedDice.push(type);
    renderStaging();
  }

  function removeDie(index) {
    selectedDice.splice(index, 1);
    renderStaging();
  }

  function renderStaging() {
    btnRoll.disabled = selectedDice.length === 0;
    btnRollHidden.disabled = selectedDice.length === 0;

    if (selectedDice.length === 0) {
      diceTray.innerHTML = '<p class="placeholder">Haz click en los dados para seleccionarlos</p>';
      return;
    }

    diceTray.innerHTML = selectedDice.map((d, i) =>
      '<span class="staged-die" data-index="' + i + '" title="Click para quitar">' + DiceSVG.render(d, 40) + '</span>'
    ).join('');

    diceTray.querySelectorAll('.staged-die').forEach(el => {
      el.addEventListener('click', () => removeDie(parseInt(el.dataset.index)));
    });
  }

  // --- Clear & Roll ---
  function clearDice() {
    selectedDice = [];
    renderStaging();
  }

  function rollDice(hidden) {
    if (selectedDice.length === 0 || !ws) return;

    const dice = {};
    selectedDice.forEach(d => dice[d] = (dice[d] || 0) + 1);

    ws.send(JSON.stringify({ type: 'roll', dice: dice, hidden: hidden === true }));
    selectedDice = [];
    renderStaging();
  }

  btnClear.addEventListener('click', clearDice);
  btnRoll.addEventListener('click', () => rollDice(false));
  btnRollHidden.addEventListener('click', () => rollDice(true));

  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      if (tokenEditor) { closeTokenEditor(); return; }
      clearDice();
    }
    if (e.key === 'Enter') rollDice(e.shiftKey);
  });

  // --- Session code in the URL and on the clipboard ---
  // Without the code in the address bar a reload would fire action=create and
  // silently strand everyone in a brand new empty room.
  function rememberCode(code) {
    const url = new URL(window.location.href);
    if (url.searchParams.get('code') === code) return;
    url.searchParams.set('code', code);
    window.history.replaceState(null, '', url.toString());
  }

  function inviteLink() {
    const code = sessionCode || codeEl.textContent;
    return window.location.origin + '/?code=' + encodeURIComponent(code);
  }

  codeEl.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteLink()).then(() => {
      showToast('Enlace de invitacion copiado');
    }, () => {
      showToast('No se pudo copiar el enlace');
    });
  });

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // --- Log ---
  function addLogEntry(entry) {
    if (logEmpty) logEmpty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'log-entry';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = entry.name;
    div.appendChild(nameSpan);

    // The server strips the numbers before they ever reach a client that is
    // not allowed to see them, so there is nothing here to hide client-side.
    if (entry.redacted) {
      div.classList.add('log-redacted');
      if (entry.band) {
        // Host's hidden roll: the table gets the shape of it, not the numbers.
        const n = entry.diceCount;
        div.appendChild(document.createTextNode(
          ' ha tirado ' + n + (n === 1 ? ' dado' : ' dados') + ' y ha salido '));
        const bandSpan = document.createElement('span');
        bandSpan.className = 'log-band';
        bandSpan.textContent = entry.band;
        div.appendChild(bandSpan);
      } else {
        div.appendChild(document.createTextNode(' hace una tirada oculta'));
      }
      logEntries.prepend(div);
      return;
    }

    div.appendChild(document.createTextNode(' lanza '));

    const formulaSpan = document.createElement('span');
    formulaSpan.className = 'formula';
    formulaSpan.textContent = entry.formula;
    div.appendChild(formulaSpan);

    div.appendChild(document.createTextNode(' obteniendo: '));

    const resultsSpan = document.createElement('span');
    resultsSpan.className = 'results';
    resultsSpan.textContent = entry.results.join(', ');
    div.appendChild(resultsSpan);

    if (entry.hidden) {
      div.classList.add('log-hidden');
      const badge = document.createElement('span');
      badge.className = 'log-badge';
      badge.textContent = 'oculta';
      badge.title = 'Solo la veis quien tira y el creador de la sala';
      div.appendChild(badge);
    }

    logEntries.prepend(div);
  }

  function updatePlayers(players) {
    playerListEl.textContent = players.join(', ');
  }

  // --- WebSocket ---
  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = protocol + '//' + window.location.host + '/ws?name=' + encodeURIComponent(name);

    if (sessionCode) {
      wsUrl += '&action=join&code=' + encodeURIComponent(sessionCode);
    } else {
      wsUrl += '&action=create';
    }

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      banner.classList.remove('show');
      reconnectDelay = 1000;
      startHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      if (event.data === 'pong') {
        clearTimeout(pongTimer);
        pongTimer = null;
        return;
      }
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'created':
          sessionCode = msg.code;
          codeEl.textContent = msg.code;
          document.title = 'TiraDados - ' + msg.code;
          rememberCode(msg.code);
          break;

        case 'joined':
          sessionCode = msg.code;
          codeEl.textContent = msg.code;
          document.title = 'TiraDados - ' + msg.code;
          rememberCode(msg.code);
          updatePlayers(msg.players);
          if (msg.log && msg.log.length > 0) {
            logEmpty.style.display = 'none';
            msg.log.forEach(entry => addLogEntry(entry));
          }
          if (msg.background) setBackground(msg.background);
          setTokens(msg.tokens || []);
          break;

        case 'token-added':
          renderToken(msg.token);
          break;

        case 'token-moved': {
          const moved = mapTokens.get(msg.id);
          // Ignore echoes for the token this client is currently dragging.
          if (!moved || draggingTokenId === msg.id) break;
          moved.data.x = msg.x;
          moved.data.y = msg.y;
          placeToken(moved);
          break;
        }

        case 'token-updated': {
          const updated = mapTokens.get(msg.id);
          if (!updated) break;
          updated.data.label = msg.label;
          updated.data.color = msg.color;
          renderToken(updated.data);
          break;
        }

        case 'token-removed':
          removeToken(msg.id);
          break;

        case 'roll-result':
          addLogEntry(msg);
          break;

        case 'background':
          setBackground(msg.data);
          break;

        case 'player-joined':
          updatePlayers(msg.players);
          break;

        case 'player-left':
          updatePlayers(msg.players);
          break;

        case 'error':
          showToast(msg.message);
          // A fatal error means the server turned us away on purpose.
          // Reconnecting would just loop, so stop trying.
          if (msg.fatal) rejected = true;
          if (msg.message.includes('no encontrada')) {
            setTimeout(() => window.location.href = '/', 2000);
          }
          break;
      }
    });

    ws.addEventListener('close', (e) => {
      stopHeartbeat();
      if (rejected || (e.code >= 4000 && e.code < 5000)) {
        banner.classList.remove('show');
        return;
      }
      banner.classList.add('show');
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
        function startHeartbeat() {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send('ping');
      // No reply in time means the socket is dead even though the browser
      // still thinks it is open. Drop it and let the reconnect logic run.
      if (pongTimer) return;
      pongTimer = setTimeout(() => {
        pongTimer = null;
        try { ws.close(); } catch {}
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  function stopHeartbeat() {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  }

  connect();
      }, reconnectDelay);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  connect();

  // --- Background image ---
  // Fit mode is a local display preference: panel widths differ per player,
  // so it is not broadcast to the room.
  const diceArea = document.querySelector('.dice-area');
  const BG_MODE_KEY = 'tiradados-bg-mode';
  let bgMode = localStorage.getItem(BG_MODE_KEY) === 'cover' ? 'cover' : 'contain';
  let bgClearBtn = null;
  let bgModeBtn = null;

  function applyBgMode() {
    stagingEl.style.backgroundSize = bgMode;
    stagingEl.style.backgroundRepeat = 'no-repeat';
    stagingEl.style.backgroundPosition = 'center';
    if (bgModeBtn) {
      const fitting = bgMode === 'contain';
      bgModeBtn.textContent = fitting ? 'Rellenar' : 'Ajustar';
      bgModeBtn.title = fitting
        ? 'Rellenar el area recortando los bordes de la imagen'
        : 'Ajustar la imagen entera dentro del area';
    }
  }

  function setBackground(dataUrl) {
    if (dataUrl) {
      stagingEl.style.backgroundImage = 'url(' + dataUrl + ')';
      showBgControls();
      applyBgMode();
    } else {
      stagingEl.style.backgroundImage = '';
      hideBgControls();
    }
  }

  function showBgControls() {
    if (bgClearBtn) return;
    const actions = diceArea.querySelector('.dice-actions');

    bgModeBtn = document.createElement('button');
    bgModeBtn.className = 'btn-bg-mode';
    bgModeBtn.addEventListener('click', () => {
      bgMode = bgMode === 'contain' ? 'cover' : 'contain';
      localStorage.setItem(BG_MODE_KEY, bgMode);
      applyBgMode();
    });
    actions.appendChild(bgModeBtn);

    bgClearBtn = document.createElement('button');
    bgClearBtn.className = 'btn-bg-clear';
    bgClearBtn.textContent = 'Quitar fondo';
    bgClearBtn.title = 'Quitar imagen de fondo';
    bgClearBtn.addEventListener('click', () => {
      if (!ws) return;
      ws.send(JSON.stringify({ type: 'background', data: null }));
      setBackground(null);
    });
    actions.appendChild(bgClearBtn);
  }

  function hideBgControls() {
    if (bgModeBtn) {
      bgModeBtn.remove();
      bgModeBtn = null;
    }
    if (bgClearBtn) {
      bgClearBtn.remove();
      bgClearBtn = null;
    }
  }

  function resizeAndSend(file) {
    var maxSize = 1200;
    var img = new Image();
    img.onload = function () {
      var w = img.width;
      var h = img.height;
      if (w > maxSize || h > maxSize) {
        if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
        else { w = Math.round(w * maxSize / h); h = maxSize; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      if (ws) ws.send(JSON.stringify({ type: 'background', data: dataUrl }));
      setBackground(dataUrl);
    };
    img.src = URL.createObjectURL(file);
  }

  // Drag & drop on the staging area
  stagingEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    stagingEl.classList.add('drag-over');
  });

  stagingEl.addEventListener('dragleave', () => {
    stagingEl.classList.remove('drag-over');
  });

  stagingEl.addEventListener('drop', (e) => {
    e.preventDefault();
    stagingEl.classList.remove('drag-over');
    var files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      resizeAndSend(files[0]);
    }
  });

  // --- Map tokens ---
  // Positions are fractions of the map (0..1), never pixels: the divider makes
  // the panel a different width on every screen.
  const TOKEN_COLORS = [
    '#e6394b', '#3aa7ff', '#4cd964', '#ffd700',
    '#b46cff', '#ff8c42', '#00d2c3', '#ff6fc0',
  ];
  const MOVE_THROTTLE_MS = 60;

  const mapTokens = new Map(); // id -> { data, el }
  let draggingTokenId = null;
  let dragMoved = false;
  let grabDx = 0;
  let grabDy = 0;
  let lastMoveSent = 0;
  let tokenEditor = null;
  let editingTokenId = null;

  function clampPos(v) {
    return Math.max(0.02, Math.min(0.98, v));
  }

  function initials(label) {
    const parts = label.trim().split(/\s+/).slice(0, 2);
    const text = parts.map(p => p.charAt(0)).join('').toUpperCase();
    return text || '?';
  }

  // Dark text on light fills, white on dark ones, so labels stay legible on
  // every palette colour.
  function readableOn(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#14142a' : '#ffffff';
  }

  function placeToken(entry) {
    entry.el.style.left = (entry.data.x * 100) + '%';
    entry.el.style.top = (entry.data.y * 100) + '%';
  }

  function renderToken(data) {
    let entry = mapTokens.get(data.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'map-token';
      el.dataset.id = data.id;
      const dotEl = document.createElement('div');
      dotEl.className = 'map-token-dot';
      const nameEl = document.createElement('div');
      nameEl.className = 'map-token-name';
      el.appendChild(dotEl);
      el.appendChild(nameEl);
      el.addEventListener('pointerdown', onTokenPointerDown);
      tokenLayer.appendChild(el);
      entry = { data: data, el: el };
      mapTokens.set(data.id, entry);
    }
    entry.data = data;

    const dot = entry.el.querySelector('.map-token-dot');
    dot.style.background = data.color;
    dot.style.color = readableOn(data.color);
    dot.textContent = initials(data.label);
    entry.el.querySelector('.map-token-name').textContent = data.label;
    entry.el.classList.toggle('is-player', data.kind === 'player');
    entry.el.title = data.label;
    placeToken(entry);
  }

  function removeToken(id) {
    const entry = mapTokens.get(id);
    if (!entry) return;
    entry.el.remove();
    mapTokens.delete(id);
    if (editingTokenId === id) closeTokenEditor(true);
  }

  function setTokens(list) {
    const incoming = new Set(list.map(t => t.id));
    Array.from(mapTokens.keys()).forEach(id => {
      if (!incoming.has(id)) removeToken(id);
    });
    list.forEach(renderToken);
  }

  function sendToken(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  // --- Dragging ---
  function onTokenPointerDown(e) {
    const entry = mapTokens.get(e.currentTarget.dataset.id);
    if (!entry) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = stagingEl.getBoundingClientRect();
    draggingTokenId = entry.data.id;
    dragMoved = false;
    grabDx = e.clientX - (rect.left + entry.data.x * rect.width);
    grabDy = e.clientY - (rect.top + entry.data.y * rect.height);
    entry.el.setPointerCapture(e.pointerId);
    entry.el.classList.add('dragging');
  }

  function onTokenPointerMove(e) {
    if (!draggingTokenId) return;
    const entry = mapTokens.get(draggingTokenId);
    if (!entry) return;

    const rect = stagingEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clampPos((e.clientX - grabDx - rect.left) / rect.width);
    const y = clampPos((e.clientY - grabDy - rect.top) / rect.height);

    if (Math.abs(x - entry.data.x) * rect.width > 3 ||
        Math.abs(y - entry.data.y) * rect.height > 3) {
      dragMoved = true;
    }

    entry.data.x = x;
    entry.data.y = y;
    placeToken(entry);

    // Throttled while dragging; the exact final position goes out on release.
    const now = Date.now();
    if (now - lastMoveSent >= MOVE_THROTTLE_MS) {
      lastMoveSent = now;
      sendToken({ type: 'token-move', id: entry.data.id, x: x, y: y });
    }
  }

  function onTokenPointerUp() {
    if (!draggingTokenId) return;
    const entry = mapTokens.get(draggingTokenId);
    const id = draggingTokenId;
    draggingTokenId = null;

    if (entry) {
      entry.el.classList.remove('dragging');
      sendToken({ type: 'token-move', id: id, x: entry.data.x, y: entry.data.y });
    }
    // A press that never moved is a click: open the editor instead.
    if (!dragMoved) openTokenEditor(id);
  }

  document.addEventListener('pointermove', onTokenPointerMove);
  document.addEventListener('pointerup', onTokenPointerUp);
  document.addEventListener('pointercancel', onTokenPointerUp);

  // --- Editor popover ---
  function openTokenEditor(id) {
    closeTokenEditor(true);
    const entry = mapTokens.get(id);
    if (!entry) return;
    editingTokenId = id;

    const box = document.createElement('div');
    box.className = 'token-editor';
    if (entry.data.y > 0.6) box.classList.add('above');
    box.style.left = (entry.data.x * 100) + '%';
    box.style.top = (entry.data.y * 100) + '%';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'token-editor-name';
    input.maxLength = 18;
    input.value = entry.data.label;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') closeTokenEditor();
      if (e.key === 'Escape') closeTokenEditor(true);
    });
    box.appendChild(input);

    const colors = document.createElement('div');
    colors.className = 'token-editor-colors';
    TOKEN_COLORS.forEach(c => {
      const swatch = document.createElement('button');
      swatch.className = 'token-swatch';
      swatch.style.background = c;
      swatch.title = c;
      if (c.toLowerCase() === entry.data.color.toLowerCase()) {
        swatch.classList.add('selected');
      }
      swatch.addEventListener('click', () => {
        sendToken({ type: 'token-update', id: id, color: c });
        closeTokenEditor();
      });
      colors.appendChild(swatch);
    });
    box.appendChild(colors);

    const del = document.createElement('button');
    del.className = 'token-editor-del';
    del.textContent = 'Eliminar ficha';
    del.addEventListener('click', () => {
      sendToken({ type: 'token-remove', id: id });
      closeTokenEditor(true);
    });
    box.appendChild(del);

    tokenLayer.appendChild(box);
    tokenEditor = box;

    // A token near the edge would push the popover off a narrow screen.
    const mapRect = stagingEl.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    let shift = 0;
    if (boxRect.left < mapRect.left + 4) shift = mapRect.left + 4 - boxRect.left;
    else if (boxRect.right > mapRect.right - 4) shift = mapRect.right - 4 - boxRect.right;
    if (shift) box.style.marginLeft = Math.round(shift) + 'px';

    // On touch, focusing would throw up the keyboard over the map before the
    // user has said they want to rename anything.
    if (!window.matchMedia('(pointer: coarse)').matches) {
      input.focus();
      input.select();
    }
  }

  function closeTokenEditor(discard) {
    if (!tokenEditor) return;
    const entry = mapTokens.get(editingTokenId);
    const input = tokenEditor.querySelector('.token-editor-name');
    const next = input ? input.value.trim() : '';
    if (!discard && entry && next && next !== entry.data.label) {
      sendToken({ type: 'token-update', id: entry.data.id, label: next });
    }
    tokenEditor.remove();
    tokenEditor = null;
    editingTokenId = null;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!tokenEditor || tokenEditor.contains(e.target)) return;
    closeTokenEditor();
  });

  // --- NPC pool ---
  TOKEN_COLORS.forEach(c => {
    const chip = document.createElement('button');
    chip.className = 'token-chip';
    chip.style.background = c;
    chip.title = 'Anadir una ficha de este color';
    chip.addEventListener('click', () => sendToken({ type: 'token-add', color: c }));
    tokenPalette.appendChild(chip);
  });

  // --- Resizable divider ---
  const divider = document.getElementById('divider');
  const main = document.querySelector('.session-main');
  let dragging = false;

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function onPointerDown(e) {
    dragging = true;
    divider.classList.add('active');
    divider.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();

    if (isMobile()) {
      const y = e.clientY - rect.top;
      const total = rect.height;
      const pct = Math.max(15, Math.min(85, (y / total) * 100));
      main.style.setProperty('--top', pct + '%');
      main.style.setProperty('--bottom', (100 - pct) + '%');
    } else {
      const x = e.clientX - rect.left;
      const total = rect.width;
      const pct = Math.max(20, Math.min(80, (x / total) * 100));
      main.style.setProperty('--left', pct + '%');
      main.style.setProperty('--right', (100 - pct) + '%');
    }
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('active');
    document.body.style.userSelect = '';
  }

  divider.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
})();
