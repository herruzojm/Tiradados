(function () {
  // --- Parse URL params ---
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name');
  const code = params.get('code'); // null if creating

  if (!name) {
    window.location.href = '/';
    return;
  }

  // --- DOM refs ---
  const codeEl = document.getElementById('session-code');
  const playerListEl = document.getElementById('player-list');
  const selectorEl = document.getElementById('dice-selector');
  const stagingEl = document.getElementById('dice-staging');
  const btnClear = document.getElementById('btn-clear');
  const btnRoll = document.getElementById('btn-roll');
  const logEntries = document.getElementById('log-entries');
  const logEmpty = document.getElementById('log-empty');
  const banner = document.getElementById('connection-banner');

  // --- State ---
  let selectedDice = [];
  let ws = null;
  let sessionCode = code;
  let reconnectDelay = 1000;

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

    if (selectedDice.length === 0) {
      stagingEl.innerHTML = '<p class="placeholder">Haz click en los dados para seleccionarlos</p>';
      return;
    }

    stagingEl.innerHTML = selectedDice.map((d, i) =>
      '<span class="staged-die" data-index="' + i + '" title="Click para quitar">' + DiceSVG.render(d, 40) + '</span>'
    ).join('');

    stagingEl.querySelectorAll('.staged-die').forEach(el => {
      el.addEventListener('click', () => removeDie(parseInt(el.dataset.index)));
    });
  }

  // --- Clear & Roll ---
  function clearDice() {
    selectedDice = [];
    renderStaging();
  }

  function rollDice() {
    if (selectedDice.length === 0 || !ws) return;

    const dice = {};
    selectedDice.forEach(d => dice[d] = (dice[d] || 0) + 1);

    ws.send(JSON.stringify({ type: 'roll', dice: dice }));
    selectedDice = [];
    renderStaging();
  }

  btnClear.addEventListener('click', clearDice);
  btnRoll.addEventListener('click', rollDice);

  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') clearDice();
    if (e.key === 'Enter') rollDice();
  });

  // --- Copy session code ---
  codeEl.addEventListener('click', () => {
    const text = sessionCode || codeEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast('Codigo copiado');
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

    const text1 = document.createTextNode(' lanza ');

    const formulaSpan = document.createElement('span');
    formulaSpan.className = 'formula';
    formulaSpan.textContent = entry.formula;

    const text2 = document.createTextNode(' obteniendo: ');

    const resultsSpan = document.createElement('span');
    resultsSpan.className = 'results';
    resultsSpan.textContent = entry.results.join(', ');

    div.appendChild(nameSpan);
    div.appendChild(text1);
    div.appendChild(formulaSpan);
    div.appendChild(text2);
    div.appendChild(resultsSpan);

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
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'created':
          sessionCode = msg.code;
          codeEl.textContent = msg.code;
          document.title = 'TiraDados - ' + msg.code;
          break;

        case 'joined':
          sessionCode = msg.code;
          codeEl.textContent = msg.code;
          document.title = 'TiraDados - ' + msg.code;
          updatePlayers(msg.players);
          if (msg.log && msg.log.length > 0) {
            logEmpty.style.display = 'none';
            msg.log.forEach(entry => addLogEntry(entry));
          }
          if (msg.background) setBackground(msg.background);
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
          // If session not found, go back
          if (msg.message.includes('no encontrada')) {
            setTimeout(() => window.location.href = '/', 2000);
          }
          break;
      }
    });

    ws.addEventListener('close', () => {
      banner.classList.add('show');
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
        connect();
      }, reconnectDelay);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  connect();

  // --- Background image ---
  const diceArea = document.querySelector('.dice-area');
  let bgClearBtn = null;

  function setBackground(dataUrl) {
    if (dataUrl) {
      stagingEl.style.backgroundImage = 'url(' + dataUrl + ')';
      stagingEl.style.backgroundSize = 'cover';
      stagingEl.style.backgroundPosition = 'center';
      showBgClearBtn();
    } else {
      stagingEl.style.backgroundImage = '';
      hideBgClearBtn();
    }
  }

  function showBgClearBtn() {
    if (bgClearBtn) return;
    bgClearBtn = document.createElement('button');
    bgClearBtn.className = 'btn-bg-clear';
    bgClearBtn.textContent = 'Quitar fondo';
    bgClearBtn.title = 'Quitar imagen de fondo';
    bgClearBtn.addEventListener('click', () => {
      if (!ws) return;
      ws.send(JSON.stringify({ type: 'background', data: null }));
      setBackground(null);
    });
    diceArea.querySelector('.dice-actions').appendChild(bgClearBtn);
  }

  function hideBgClearBtn() {
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
