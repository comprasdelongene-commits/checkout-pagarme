'use strict';

const body = document.getElementById('logs-body');
const countEl = document.getElementById('logs-count');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtMoney(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('pt-BR');
  } catch (_) {
    return iso || '—';
  }
}

function badge(result) {
  const map = {
    aprovado: ['ok', 'Aprovado'],
    recusado: ['no', 'Recusado'],
    pendente: ['warn', 'Pendente'],
    erro: ['no', 'Erro'],
  };
  const [cls, label] = map[result] || ['warn', result || '—'];
  return `<span class="tag tag-${cls}">${esc(label)}</span>`;
}

function render(entries) {
  if (!entries.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma transação registrada ainda.</td></tr>';
    countEl.textContent = '0 transações';
    return;
  }
  countEl.textContent = `${entries.length} transaç${entries.length === 1 ? 'ão' : 'ões'}`;
  body.innerHTML = entries.map((e) => (
    `<tr>
      <td>${esc(fmtDate(e.at))}</td>
      <td><code>${esc(e.key)}</code></td>
      <td>${esc(fmtMoney(e.amount))}</td>
      <td>${badge(e.result)}</td>
      <td class="muted">${esc(e.detail || '—')}</td>
    </tr>`
  )).join('');
}

async function load() {
  countEl.textContent = 'Carregando…';
  try {
    const r = await fetch('/api/logs', { headers: { Accept: 'application/json' } });
    const data = await r.json();
    render(Array.isArray(data.entries) ? data.entries : []);
  } catch (_) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Não foi possível carregar os logs.</td></tr>';
    countEl.textContent = 'erro';
  }
}

document.getElementById('refresh-btn').addEventListener('click', load);
document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('Apagar todos os logs?')) return;
  try {
    await fetch('/api/logs/clear', { method: 'POST' });
  } catch (_) {}
  load();
});

load();
