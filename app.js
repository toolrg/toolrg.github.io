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
const tablePreview = document.getElementById('tablePreview');

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

function isHumanVerificationGate(html) {
  if (!html || typeof html !== 'string') {
    return false;
  }

  const text = html.toLowerCase();
  return /serviço temporariamente indisponível|servico temporariamente indisponivel|verificação humana|verificacao humana|cloudflare|turnstile|captcha/i.test(text);
}

function hasRealAvailabilityTable(html) {
  if (!html || typeof html !== 'string') {
    return false;
  }

  return /<table\s|<tbody|<tr\s|<td\s/i.test(html);
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

function extractBrowserGeneratedLinksFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return [];
  }

  const patterns = [
    /abrirNovoCadastro\s*\(\s*['"`]+([^'"`]+)['"`]+\s*\)/gi,
    /document\.location\s*=\s*['"`]+([^'"`]+)['"`]+/gi,
    /window\.location(?:\.href)?\s*=\s*['"`]+([^'"`]+)['"`]+/gi,
    /location\.href\s*=\s*['"`]+([^'"`]+)['"`]+/gi,
  ];

  const links = [];
  const seen = new Set();

  patterns.forEach((pattern) => {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const candidate = match[1];
      if (!candidate) {
        continue;
      }

      const resolved = resolveRealLink(candidate);
      if (resolved && !seen.has(resolved)) {
        links.push(resolved);
        seen.add(resolved);
      }
    }
  });

  return links;
}

function extractRowLink(row) {
  const sourceCandidates = [
    row?.querySelector('a[href]')?.getAttribute('href'),
    row?.getAttribute('data-link'),
    row?.getAttribute('data-url'),
    row?.getAttribute('href'),
    row?.getAttribute('onclick'),
    row?.getAttribute('data-action'),
  ];

  for (const candidate of sourceCandidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }

    const onclickMatch = candidate.match(/(?:abrirNovoCadastro|window\.location|document\.location|location\.href)\s*(?:\(\s*|[:=]\s*)['"]([^'"]+)['"]\s*\)?/i);
    const directMatch = onclickMatch
      || candidate.match(/(?:https?:\/\/amcin\.e-instituto\.com\.br[^\s'"<>]+|\/[^\s'"<>]*)/i);

    const possibleLink = directMatch ? (onclickMatch ? onclickMatch[1] : directMatch[1] || directMatch[0]) : candidate;
    const resolved = resolveRealLink(possibleLink);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function parseAvailabilityHtml(html) {
  if (isHumanVerificationGate(html)) {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(doc.querySelectorAll('table tr'));
  const parsed = [];
  const browserLinks = extractBrowserGeneratedLinksFromHtml(html);

  rows.forEach((row, index) => {
    const cells = Array.from(row.querySelectorAll('td')).map((cell) => normalizeText(cell.textContent));

    if (cells.length < 3) {
      return;
    }

    const [local, period, availability] = cells;
    const headerMatch = [local, period, availability].some((value) => /local|período|disponibilidade/i.test(value));

    if (headerMatch || !local || !period || !availability) {
      return;
    }

    let link = extractRowLink(row);
    if (!link && browserLinks.length > 0) {
      link = browserLinks[index % browserLinks.length] || browserLinks[0];
    }

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
  return rows;
}

function getPositiveKey(rows) {
  return rows
    .filter((item) => isPositiveAvailability(item.availability))
    .map((item) => `${item.local}|${item.period}|${item.link || item.availability}|${item.availability}`)
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

function renderTablePreview(rows) {
  if (!tablePreview) {
    return;
  }

  tablePreview.innerHTML = '';

  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 4;
    emptyCell.textContent = 'Nenhuma linha de localização foi identificada na tabela.';
    emptyRow.appendChild(emptyCell);
    tablePreview.appendChild(emptyRow);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const localCell = document.createElement('td');
    localCell.textContent = row.local || '—';

    const periodCell = document.createElement('td');
    periodCell.textContent = row.period || '—';

    const availabilityCell = document.createElement('td');
    availabilityCell.textContent = row.availability || '—';

    const linkCell = document.createElement('td');
    if (row.link) {
      const link = document.createElement('a');
      link.href = row.link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = row.link;
      linkCell.appendChild(link);
    } else {
      linkCell.textContent = 'Sem link';
    }

    tr.appendChild(localCell);
    tr.appendChild(periodCell);
    tr.appendChild(availabilityCell);
    tr.appendChild(linkCell);
    tablePreview.appendChild(tr);
  });
}

function renderRows(rows) {
  resultList.innerHTML = '';

  if (!rows.length) {
    return;
  }

  rows.forEach((row) => {
    const item = document.createElement('li');
    item.className = 'result-item';

    const isPositive = isPositiveAvailability(row.availability);
    if (isPositive) {
      item.classList.add('item-positive');
    } else {
      item.classList.add('item-neutral');
    }

    if (row.link) {
      item.classList.add('clickable');
      item.title = 'Abrir agendamento real';
      item.addEventListener('click', () => {
        if (row.link) {
          window.location.assign(row.link);
        }
      });
    } else {
      item.title = 'Link real do agendamento não disponível neste retorno HTML.';
    }

    const title = document.createElement('strong');
    title.textContent = row.local;

    const meta = document.createElement('div');
    meta.className = 'result-period';
    meta.textContent = row.period;

    const badge = document.createElement('div');
    badge.className = 'result-status';
    badge.textContent = isPositive ? 'Disponível' : 'Sem vagas';

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(badge);
    resultList.appendChild(item);
  });
}

async function requestAvailability(url) {
  const currentOrigin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://127.0.0.1:5500';

  const liveTable = `${currentOrigin}/api/table?url=${encodeURIComponent(url)}`;
  const localProxy = `${currentOrigin}/api/check?url=${encodeURIComponent(url)}`;
  const fallbackProxy = `http://127.0.0.1:5500/api/check?url=${encodeURIComponent(url)}`;
  const endpoints = [liveTable, localProxy, fallbackProxy];

  let lastError = null;

  for (const endpoint of endpoints) {
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
      console.warn('Proxy fallback triggered:', endpoint, error);
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

    if (isHumanVerificationGate(html)) {
      renderRows([]);
      updateStatus('unknown', 'O site está bloqueado por verificação humana / CAPTCHA. Aguarde a validação do desafio para continuar.');
      return;
    }

    if (!hasRealAvailabilityTable(html)) {
      renderRows([]);
      renderTablePreview([]);
      updateStatus('unknown', 'Resposta sem tabela de locais. O endpoint do AMCin não retornou a estrutura real da disponibilidade.');
      return;
    }

    const rows = parseAvailabilityHtml(html);
    const verdict = classifyRows(rows);
    const displayRows = getDisplayRows(rows);
    const positiveKey = getPositiveKey(rows);

    renderRows(displayRows);
    renderTablePreview(rows);
    updateStatus(verdict.status, `${verdict.details} • Monitorando toda a tabela de locais • Última checagem: ${new Date().toLocaleTimeString('pt-BR')}`);

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
