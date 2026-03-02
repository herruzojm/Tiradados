(function () {
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const errorEl = document.getElementById('error');
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');

  // Auto-uppercase code input, letters only
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
  });

  function showError(msg) {
    errorEl.textContent = msg;
  }

  function getName() {
    const name = nameInput.value.trim();
    if (!name) {
      showError('Introduce tu nombre');
      nameInput.focus();
      return null;
    }
    return name;
  }

  btnCreate.addEventListener('click', () => {
    const name = getName();
    if (!name) return;
    window.location.href = '/session?name=' + encodeURIComponent(name);
  });

  btnJoin.addEventListener('click', () => {
    const name = getName();
    if (!name) return;

    const code = codeInput.value.trim();
    if (!code || code.length !== 6) {
      showError('El codigo debe tener 6 letras');
      codeInput.focus();
      return;
    }

    window.location.href = '/session?code=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(name);
  });

  // Enter key on code input triggers join
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // Enter key on name input triggers create (if no code)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (codeInput.value.trim().length === 6) {
        btnJoin.click();
      } else {
        btnCreate.click();
      }
    }
  });
})();
