const DEFAULT_URL = 'https://amcin.e-instituto.com.br/agendamento/Agendamento/LoadAgendamentoDisponivel';

const state = {
  timerId: null,
  lastNotificationKey: '',
  lastPositiveKey: '',
  deferredPrompt: null,
  lastStatus: 'unknown',
};

const statusBadge = document.getElementById('statusBadge');
const lastCheckText = document.getElementById('lastCheckText');
const resultList = document.getElementById('resultList');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const checkNowButton = document.getElementById('checkNowButton');
const urlInput = document.getElementById('urlInput');
const intervalInput = document.getElementById('intervalInput');
const installButton = document.getElementById('installButton');
const toast = document.getElementById('toast');

function loadPersistedState() {
  try {
    const raw = localStorage.getItem('monitor-vagas-state');
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (parsed.lastNotificationKey) {
      state.lastNotificationKey = parsed.lastNotificationKey;
    }
    if (parsed.lastPositiveKey) {
      state.lastPositiveKey = parsed.lastPositiveKey;
    }
    if (parsed.interval) {
      intervalInput.value = String(parsed.interval);
    }
    if (parsed.url) {
      urlInput.value = parsed.url;
    }
  } catch (error) {
    console.warn('State not restored:', error);
  }
}

function savePersistedState() {
  const payload = {
    lastNotificationKey: state.lastNotificationKey,
    lastPositiveKey: state.lastPositiveKey,
    interval: Number(intervalInput.value) || 60000,
    url: urlInput.value || DEFAULT_URL,
  };

  localStorage.setItem('monitor-vagas-state', JSON.stringify(payload));
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function isPositiveAvailability(value) {
  const text = value || '';
  const negativePattern = /nao ha vagas disponiveis|não há vagas disponíveis|sem vagas|indisponivel|indisponível|vagas indisponiveis|vagas indisponíveis/i;
  const positivePattern = /vagas? disponiveis|vagas? disponíveis|disponivel|disponível/i;

  return positivePattern.test(text) && !negativePattern.test(text);
}

function resolveRealLink(rawLink) {
  if (!rawLink || typeof rawLink !== 'string') {
    return null;
  }

  const trimmed = rawLink.trim();
  if (!trimmed) {
    return null;
  }

  const isAllowedHost = /^https?:\/\/amcin\.e-instituto\.com\.br\//i.test(trimmed)
    || /^\//.test(trimmed)
    || !/^https?:\/\//i.test(trimmed);

  if (!isAllowedHost) {
    return null;
  }

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      if (url.hostname !== 'amcin.e-instituto.com.br') {
        return null;
      }
      return url.href;
    }

    const url = new URL(trimmed, 'https://amcin.e-instituto.com.br');
    if (url.hostname !== 'amcin.e-instituto.com.br') {
      return null;
    }
    return url.href;
  } catch (error) {
    console.warn('Link real inválido descartado:', trimmed, error);
    return null;
  }
}

function extractRowLink(row) {
  const directLink = row?.querySelector('a[href]')?.getAttribute('href')
    || row?.getAttribute('data-link')
    || row?.getAttribute('data-url');

  if (directLink) {
    return resolveRealLink(directLink);
  }

  const onclick = row?.getAttribute('onclick') || '';
  const match = onclick.match(/abrirNovoCadastro\s*\(\s*['"]([^'"]+)['"]\s*\)|document\.location\s*=\s*['"]([^'"]+)['"]/i);

  const candidate = match ? (match[1] || match[2]) : null;
  return candidate ? resolveRealLink(candidate) : null;
}

function parseAvailabilityHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(doc.querySelectorAll('table tr'));
  const parsed = [];

  rows.forEach((row) => {
    const cells = Array.from(row.querySelectorAll('td')).map((cell) => normalizeText(cell.textContent));

    if (cells.length < 3) {
      return;
    }

    const [local, period, availability] = cells;
    const headerMatch = [local, period, availability].some((value) => /local|período|disponibilidade/i.test(value));

    if (headerMatch || !local || !period || !availability) {
      return;
    }

    const link = extractRowLink(row);

    parsed.push({
      local,
      period,
      availability,
      link,
    });
  });

  return parsed;
}

function classifyRows(rows) {
  const unavailablePattern = /nao ha vagas disponiveis|não há vagas disponíveis|sem vagas|indisponivel|indisponível|vagas indisponiveis|vagas indisponíveis/i;
  const positiveRows = rows.filter((row) => isPositiveAvailability(row.availability));
  const unavailableRows = rows.filter((row) => unavailablePattern.test(row.availability));

  if (positiveRows.length > 0) {
    return {
      available: true,
      status: 'available',
      details: `${positiveRows.length} registro(s) sugerem vaga disponível.`,
    };
  }

  if (unavailableRows.length > 0) {
    return {
      available: false,
      status: 'unavailable',
      details: `${unavailableRows.length} registro(s) indicam vagas indisponíveis.`,
    };
  }

  if (rows.length > 0) {
    return {
      available: false,
      status: 'unavailable',
      details: 'Nenhuma vaga disponível no momento.',
    };
  }

  return {
    available: null,
    status: 'unknown',
    details: 'Nenhuma linha de disponibilidade foi identificada.',
  };
}

function getDisplayRows(rows) {
  const positiveRows = rows.filter((row) => isPositiveAvailability(row.availability));
  return positiveRows.length > 0 ? positiveRows : rows;
}

function getPositiveKey(rows) {
  return rows
    .filter((item) => isPositiveAvailability(item.availability))
    .map((item) => `${item.local}|${item.period}|${item.availability}`)
    .join('||');
}

function updateStatus(status, text) {
  state.lastStatus = status;
  statusBadge.className = `status-badge ${status}`;
  statusBadge.textContent = status === 'available'
    ? 'Vaga disponível'
    : status === 'unavailable'
      ? 'Indisponível'
      : 'Aguardando';

  lastCheckText.textContent = text;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');

  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function renderRows(rows) {
  resultList.innerHTML = '';

  if (!rows.length) {
    return;
  }

  rows.forEach((row) => {
    const item = document.createElement('li');
    item.className = 'result-item';

    if (row.link) {
      item.classList.add('clickable');
      item.title = 'Abrir agendamento real';
      item.addEventListener('click', () => {
        if (row.link) {
          window.location.assign(row.link);
        }
      });
    }

    const title = document.createElement('strong');
    title.textContent = row.local;

    const meta = document.createElement('small');
    meta.textContent = `${row.period} • ${row.availability}`;

    item.appendChild(title);
    item.appendChild(meta);
    resultList.appendChild(item);
  });
}

async function requestAvailability(url) {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const renderApi = 'https://toolrg-github-io.onrender.com';
  const localApi = 'http://127.0.0.1:5500';
  const candidates = isLocalhost
    ? [`${localApi}/api/check?url=${encodeURIComponent(url)}`]
    : [
        `${renderApi}/api/check?url=${encodeURIComponent(url)}`,
        `${localApi}/api/check?url=${encodeURIComponent(url)}`,
      ];

  let lastError = null;

  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        mode: 'cors',
        credentials: 'same-origin',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      console.warn('Endpoint fallback triggered:', endpoint, error);
    }
  }

  throw lastError || new Error('Não foi possível consultar o endpoint de vagas.');
}

function notifyUser(message) {
  showToast(message);

  if (!('Notification' in window)) {
    return;
  }

  if (Notification.permission === 'granted') {
    new Notification('Monitor de vagas', { body: message, tag: 'vagas-monitor' });
    return;
  }

  if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        new Notification('Monitor de vagas', { body: message, tag: 'vagas-monitor' });
      }
    });
  }
}

async function checkNow() {
  const url = urlInput.value || DEFAULT_URL;
  savePersistedState();
  const statusText = `Verificando ${url}`;
  updateStatus('unknown', statusText);

  try {
    const html = await requestAvailability(url);
    const rows = parseAvailabilityHtml(html);
    const verdict = classifyRows(rows);
    const displayRows = getDisplayRows(rows);
    const positiveKey = getPositiveKey(rows);

    renderRows(displayRows);
    updateStatus(verdict.status, `${verdict.details} • Última checagem: ${new Date().toLocaleTimeString('pt-BR')}`);

    if (verdict.available === true && positiveKey && state.lastPositiveKey !== positiveKey) {
      notifyUser('Vaga disponível identificada. Verifique o sistema agora.');
      state.lastPositiveKey = positiveKey;
      state.lastNotificationKey = positiveKey;
      savePersistedState();
      return;
    }

    if (verdict.available === false) {
      state.lastPositiveKey = '';
      state.lastNotificationKey = '';
      savePersistedState();
    }
  } catch (error) {
    renderRows([]);
    const message = error && error.message
      ? `Erro ao consultar o endpoint: ${error.message}. Use o proxy local se o Render estiver bloqueado.`
      : 'Erro ao consultar o endpoint. Use o proxy local se o Render estiver bloqueado.';
    updateStatus('unknown', message);
  }
}

function startMonitoring() {
  const intervalMs = Number(intervalInput.value) || 60000;
  savePersistedState();
  stopMonitoring();
  checkNow();
  state.timerId = window.setInterval(checkNow, intervalMs);
}

function stopMonitoring() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function bindEvents() {
  startButton.addEventListener('click', startMonitoring);
  stopButton.addEventListener('click', stopMonitoring);
  checkNowButton.addEventListener('click', checkNow);

  installButton.addEventListener('click', async () => {
    if (!state.deferredPrompt) {
      return;
    }

    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    installButton.classList.add('hidden');
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    installButton.classList.remove('hidden');
  });
}

async function init() {
  loadPersistedState();
  bindEvents();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => undefined);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }

  renderRows([]);
  updateStatus(state.lastStatus || 'unknown', 'Pronto para iniciar o monitor.');
}

init();
