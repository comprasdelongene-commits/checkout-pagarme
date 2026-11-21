'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
// Base da API (pode ser trocada só para testes locais com mock).
const PAGARME_API_BASE = process.env.PAGARME_API_BASE || 'https://api.pagar.me/core/v5';

// A chave secreta de produção é lida SOMENTE da variável de ambiente. Nunca é logada nem enviada ao front.
function getSecretKey() {
  const k = process.env.PAGARME_SECRET_KEY;
  return k && k.trim() ? k.trim() : null;
}

const TEST_SECRET_RE = /^sk_test_[A-Za-z0-9_-]+$/;

// Remove qualquer ocorrência do segredo de um valor (string ou estrutura), para nunca ecoá-lo.
function scrubSecret(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map((v) => scrubSecret(v, secret));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecret(v, secret);
    return out;
  }
  return value;
}

function sendJson(res, status, payload, secret) {
  const text = scrubSecret(JSON.stringify(payload), secret);
  res.status(status).type('json').send(text);
}

const app = express();
app.set('trust proxy', 1); // Render fica atrás de proxy

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        // O navegador fala direto com a Pagar.me só para tokenizar o cartão.
        // randomuser.me é usado no modo teste para preencher dados fictícios.
        connectSrc: ["'self'", 'https://api.pagar.me', 'https://randomuser.me'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

// ---------- utilidades ----------
const randDigits = (n) => {
  let s = '';
  while (s.length < n) s += crypto.randomInt(0, 10).toString();
  return s;
};
const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const stripAccents = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function sanitizeDescriptor(v) {
  const d = stripAccents(v).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 13).trim();
  return d || 'LOJA';
}

function isValidCPF(cpf) {
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

function validate(body) {
  const errors = [];
  const productName = str(body.product_name, 100);
  if (productName.length < 2) errors.push('Informe o nome do produto.');

  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 100) errors.push('Valor mínimo é R$ 1,00.');
  if (Number.isInteger(amount) && amount > 10000000) errors.push('Valor acima do permitido.');

  const installments = body.installments === undefined ? 1 : Number(body.installments);
  if (!Number.isInteger(installments) || installments < 1 || installments > 12) errors.push('Parcelamento inválido.');

  const cardToken = str(body.card_token, 100);
  if (!/^token_[A-Za-z0-9]+$/.test(cardToken)) errors.push('Token do cartão ausente ou inválido.');

  const c = body.customer || {};
  const name = str(c.name, 64);
  const email = str(c.email, 64).toLowerCase();
  const document = onlyDigits(c.document);
  const phone = onlyDigits(c.phone);
  if (name.split(/\s+/).length < 2) errors.push('Informe nome e sobrenome.');
  if (!isEmail(email)) errors.push('E-mail inválido.');
  if (!isValidCPF(document)) errors.push('CPF inválido.');
  if (phone.length < 10 || phone.length > 11) errors.push('Telefone inválido (DDD + número).');

  const b = body.billing_address || {};
  const billing = {
    line_1: str(b.line_1, 256),
    zip_code: onlyDigits(b.zip_code),
    city: str(b.city, 64),
    state: str(b.state, 2).toUpperCase(),
    country: 'BR',
  };
  if (billing.line_1.length < 3) errors.push('Informe o endereço de cobrança.');
  if (billing.zip_code.length !== 8) errors.push('CEP inválido.');
  if (billing.city.length < 2) errors.push('Informe a cidade.');
  if (!/^[A-Z]{2}$/.test(billing.state)) errors.push('UF inválida.');

  return {
    errors,
    data: {
      productName,
      amount,
      installments,
      cardToken,
      descriptor: sanitizeDescriptor(body.statement_descriptor),
      billing,
      customer: { name, email, document, areaCode: phone.slice(0, 2), number: phone.slice(2) },
    },
  };
}

function buildOrder(d) {
  return {
    antifraud_enabled: false,
    code: `PED-${randDigits(8)}`,
    items: [
      { amount: d.amount, description: d.productName, quantity: 1, code: `SKU-${randDigits(6)}` },
    ],
    customer: {
      name: d.customer.name,
      email: d.customer.email,
      type: 'individual',
      document: d.customer.document,
      document_type: 'CPF',
      phones: {
        mobile_phone: { country_code: '55', area_code: d.customer.areaCode, number: d.customer.number },
      },
    },
    payments: [
      {
        payment_method: 'credit_card',
        credit_card: {
          installments: d.installments,
          statement_descriptor: d.descriptor,
          operation_type: 'auth_and_capture',
          card_token: d.cardToken,
          card: { billing_address: d.billing },
        },
      },
    ],
  };
}

const STATUS_PT = {
  paid: 'Pagamento aprovado',
  captured: 'Pagamento aprovado',
  authorized_pending_capture: 'Pagamento autorizado',
  pending: 'Pagamento em análise',
  processing: 'Pagamento em processamento',
  not_authorized: 'Pagamento não autorizado pelo banco emissor',
  failed: 'Pagamento recusado',
  canceled: 'Pagamento cancelado',
  with_error: 'Erro ao processar o pagamento',
};

// Resultado limpo para o cliente (nada de JSON bruto no fluxo de produção).
function summarize(order, fallback) {
  const charge = (order.charges && order.charges[0]) || {};
  const tx = charge.last_transaction || {};
  const card = tx.card || {};
  const status = charge.status || order.status || 'failed';
  const approved = status === 'paid' || tx.status === 'captured';
  const pending = !approved && ['pending', 'processing', 'authorized_pending_capture'].includes(status);

  let message = STATUS_PT[approved ? 'paid' : status] || 'Pagamento recusado';
  if (!approved && !pending) {
    const reason =
      (tx.acquirer_message && tx.acquirer_message !== 'Approved' ? tx.acquirer_message : '') ||
      (tx.antifraud_response && tx.antifraud_response.status === 'reproved' ? 'Recusado pela análise antifraude' : '');
    if (reason) message += ` — ${reason}`;
  }

  return {
    ok: true,
    approved,
    pending,
    title: approved ? 'Pagamento aprovado' : pending ? 'Pagamento em análise' : 'Pagamento recusado',
    message,
    order_code: order.code || fallback.code,
    amount: order.amount ?? fallback.amount,
    product: (order.items && order.items[0] && order.items[0].description) || fallback.productName,
    installments: tx.installments || fallback.installments,
    card_brand: card.brand || null,
    card_last4: card.last_four_digits || null,
    auth_code: approved ? tx.acquirer_auth_code || null : null,
    tid: approved ? tx.acquirer_tid || null : null,
    statement_descriptor: tx.statement_descriptor || fallback.descriptor,
  };
}

function apiErrorMessage(status, body) {
  if (status === 401) return 'Configuração de pagamento inválida. Avise a loja.';
  if (status === 422 || status === 400) {
    const errs = body && body.errors ? Object.values(body.errors).flat().filter(Boolean) : [];
    return errs.length ? `Dados recusados: ${errs.slice(0, 3).join(' ')}` : 'Dados de pagamento inválidos. Confira e tente novamente.';
  }
  return 'Não foi possível processar o pagamento agora. Tente novamente em instantes.';
}

// Extrai a chave de teste do body (se houver), apaga o campo e valida o prefixo sk_test_.
// A chave só vive nesta requisição: nunca é logada, gravada ou devolvida.
function takeRequestSecret(body) {
  const raw = body && typeof body.test_secret_key === 'string' ? body.test_secret_key.trim() : '';
  if (body && Object.prototype.hasOwnProperty.call(body, 'test_secret_key')) {
    delete body.test_secret_key;
  }
  if (!raw) return { secret: getSecretKey(), testMode: false, error: null };
  if (!TEST_SECRET_RE.test(raw)) {
    return {
      secret: null,
      testMode: false,
      error: 'Use apenas uma chave secreta de TESTE (prefixo sk_test_).',
    };
  }
  return { secret: raw, testMode: true, error: null };
}

app.post('/api/pay', payLimiter, async (req, res) => {
  const body = req.body || {};
  const { secret, testMode, error: keyError } = takeRequestSecret(body);
  if (keyError) {
    return res.status(400).json({ ok: false, error: keyError });
  }
  if (!secret) {
    console.error('[pay] PAGARME_SECRET_KEY não configurada');
    return res.status(503).json({ ok: false, error: 'Pagamentos indisponíveis no momento (loja não configurada).' });
  }

  const { errors, data } = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });

  const order = buildOrder(data);
  const fallback = { code: order.code, amount: data.amount, productName: data.productName, installments: data.installments, descriptor: data.descriptor };

  try {
    const r = await fetch(`${PAGARME_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${secret}:`).toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(30000),
    });
    const apiBody = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.warn(`[pay] pedido ${order.code} rejeitado pela API: HTTP ${r.status}`);
      const payload = { ok: false, error: apiErrorMessage(r.status, apiBody) };
      if (testMode) {
        payload.test_mode = true;
        payload.title = 'Pagamento recusado';
        payload.message = payload.error;
        payload.pagarme = apiBody;
      }
      return sendJson(res, r.status >= 500 ? 502 : 400, payload, secret);
    }

    const result = summarize(apiBody, fallback);
    if (testMode) {
      result.test_mode = true;
      result.pagarme = apiBody;
    }
    console.log(`[pay] pedido ${result.order_code} -> ${result.approved ? 'aprovado' : result.pending ? 'pendente' : 'recusado'}`);
    return sendJson(res, 200, result, secret);
  } catch (err) {
    console.error(`[pay] falha de comunicação no pedido ${order.code}: ${err.name}`);
    const payload = { ok: false, error: 'Falha de comunicação com o processador. Tente novamente.' };
    if (testMode) payload.test_mode = true;
    return sendJson(res, 502, payload, secret);
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Checkout rodando na porta ${PORT}${getSecretKey() ? '' : ' (ATENÇÃO: PAGARME_SECRET_KEY não definida)'}`);
  });
}

module.exports = { app, validate, buildOrder, summarize, sanitizeDescriptor, isValidCPF, scrubSecret, takeRequestSecret };
