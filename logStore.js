'use strict';

const fs = require('fs');
const path = require('path');

// Guarda um histórico das transações de teste para a homologação.
// A chave privada é SEMPRE mascarada: nunca gravamos o segredo completo.
const DATA_DIR = process.env.LOG_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'logs.json');
const MAX = 1000;

let entries = [];

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) entries = arr.slice(-MAX);
  } catch (_) {
    entries = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(entries.slice(-MAX)), 'utf8');
  } catch (_) {
    /* disco efêmero: tudo bem, mantemos em memória */
  }
}

// Mostra o suficiente para distinguir uma chave da outra, sem revelar o segredo.
function maskKey(sk) {
  if (!sk || typeof sk !== 'string') return '—';
  const s = sk.trim();
  if (s.length <= 12) return s.slice(0, 4) + '…';
  const head = s.slice(0, 8); // ex.: sk_test_ ou sk_live_ ou sk_ab12
  const tail = s.slice(-4);
  return `${head}…${tail}`;
}

function add(entry) {
  const row = {
    at: new Date().toISOString(),
    key: maskKey(entry.secret),
    amount: Number(entry.amount) || 0, // em centavos
    result: entry.result || 'erro', // aprovado | recusado | pendente | erro
    order_code: entry.order_code || null,
    detail: entry.detail || null,
  };
  entries.push(row);
  if (entries.length > MAX) entries = entries.slice(-MAX);
  persist();
  return row;
}

function list() {
  return entries.slice().reverse(); // mais recente primeiro
}

function clear() {
  entries = [];
  persist();
}

load();

module.exports = { add, list, clear, maskKey };
