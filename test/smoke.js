'use strict';
// Smoke test: sobe o app apontando para um MOCK local da Pagar.me. Nenhuma chamada real, nenhuma cobrança.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DUMMY_SECRET = 'dummy_test_secret_not_real';
const TEST_SECRET = 'sk_test_SMOKESECRETKEY99XYZ';
let lastOrder = null, lastAuth = null, mode = 'paid', mockHits = 0;

const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    mockHits += 1;
    lastAuth = req.headers.authorization;
    lastOrder = JSON.parse(b || '{}');
    const tx = mode === 'paid'
      ? { status: 'captured', acquirer_message: 'Approved', acquirer_tid: '42462901398052', acquirer_auth_code: 'YKHWBR', installments: 1, statement_descriptor: lastOrder.payments[0].credit_card.statement_descriptor, card: { brand: 'Visa', last_four_digits: '1111' } }
      : { status: 'not_authorized', acquirer_message: 'Transação não autorizada', installments: 1, card: { brand: 'Visa', last_four_digits: '1111' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'or_mock', code: lastOrder.code, amount: lastOrder.items[0].amount, status: mode === 'paid' ? 'paid' : 'failed',
      items: lastOrder.items, customer: { document: lastOrder.customer.document },
      charges: [{ status: mode === 'paid' ? 'paid' : 'failed', last_transaction: tx }],
    }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url) { for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch { await sleep(100); } } throw new Error('não subiu'); }

const validBody = {
  product_name: 'Plano Essencial', amount: 5000, installments: 1, statement_descriptor: 'Ação Lojã!!',
  card_token: 'token_abc123XYZ',
  customer: { name: 'Fulano de Tal', email: 'fulano@exemplo.com', document: '529.982.247-25', phone: '(11) 99999-9999' },
  billing_address: { line_1: '100, Av Paulista, Bela Vista', zip_code: '01310-100', city: 'Sao Paulo', state: 'sp', country: 'BR' },
};
const post = (base, body) => fetch(base + '/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function start(port, env) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.logs = ''; p.stdout.on('data', (d) => (p.logs += d)); p.stderr.on('data', (d) => (p.logs += d));
  return p;
}

(async () => {
  await new Promise((r) => mock.listen(4599, r));
  const app = start(4600, { PAGARME_SECRET_KEY: DUMMY_SECRET, PAGARME_API_BASE: 'http://127.0.0.1:4599' });
  const base = 'http://127.0.0.1:4600';
  try {
    await waitUp(base + '/healthz');

    let r = await fetch(base + '/');
    const html = await r.text();
    assert.strictEqual(r.status, 200); assert.ok(html.includes('id="checkout"'));
    assert.ok(html.includes('Modo teste / homologação'));
    assert.ok(html.includes('id="test_secret_key"') && html.includes('type="password"'));
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(csp.includes('https://api.pagar.me'));
    assert.ok(csp.includes('https://randomuser.me'));
    for (const f of ['/app.js', '/styles.css']) assert.strictEqual((await fetch(base + f)).status, 200, f);
    console.log('✓ página e assets servidos (200), CSP permite api.pagar.me e randomuser.me');

    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(!/sk_(?:test_|live_)?[A-Za-z0-9]{12,}/.test(appJs), 'app.js não deve conter uma chave secreta real (sk_...)');
    assert.ok(!/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/.test(appJs), 'app.js não deve conter PAN');
    console.log('✓ app.js sem chave secreta e sem PAN');

    r = await post(base, { ...validBody, amount: 12.5 });
    assert.strictEqual(r.status, 400);
    r = await post(base, { ...validBody, card_token: '4111111111111111' });
    assert.strictEqual(r.status, 400);
    r = await post(base, { ...validBody, customer: { ...validBody.customer, document: '111.111.111-11' } });
    assert.strictEqual(r.status, 400);
    console.log('✓ validação no servidor (valor não-inteiro, PAN no lugar do token, CPF inválido -> 400)');

    r = await post(base, validBody);
    let j = await r.json();
    assert.strictEqual(r.status, 200); assert.strictEqual(j.approved, true);
    assert.strictEqual(lastAuth, 'Basic ' + Buffer.from(DUMMY_SECRET + ':').toString('base64'));
    assert.match(lastOrder.code, /^PED-\d{8}$/); assert.match(lastOrder.items[0].code, /^SKU-\d{6}$/);
    assert.strictEqual(lastOrder.items[0].amount, 5000); assert.strictEqual(lastOrder.items[0].description, 'Plano Essencial');
    const cc = lastOrder.payments[0].credit_card;
    assert.strictEqual(cc.card_token, 'token_abc123XYZ'); assert.strictEqual(cc.operation_type, 'auth_and_capture');
    assert.strictEqual(cc.statement_descriptor, 'ACAO LOJA');
    assert.ok(!cc.card.number && !cc.card.cvv, 'nenhum PAN/CVV no pedido');
    assert.strictEqual(cc.card.billing_address.state, 'SP');
    assert.strictEqual(lastOrder.customer.phones.mobile_phone.area_code, '11');
    assert.ok(!('customer' in j) && !('charges' in j) && !('pagarme' in j) && !('test_mode' in j), 'sem JSON bruto para o cliente');
    assert.strictEqual(j.tid, '42462901398052'); assert.strictEqual(j.card_last4, '1111');
    assert.strictEqual(lastOrder.antifraud_enabled, false);
    console.log('✓ aprovado (mock):', JSON.stringify(j));

    mode = 'declined';
    j = await (await post(base, validBody)).json();
    assert.strictEqual(j.approved, false); assert.strictEqual(j.tid, null);
    assert.ok(!('pagarme' in j) && !('test_mode' in j) && !('customer' in j) && !('charges' in j), 'sem JSON bruto para o cliente');
    console.log('✓ recusado (mock):', j.title, '-', j.message);

    mode = 'paid';
    const hitsBefore = mockHits;
    r = await post(base, { ...validBody, test_secret_key: 'chave_invalida_123' });
    j = await r.json();
    assert.strictEqual(r.status, 400);
    assert.ok(/sk_/.test(j.error));
    assert.strictEqual(mockHits, hitsBefore, 'chave inválida (sem prefixo sk_) não deve chamar a API');
    console.log('✓ chave secreta sem prefixo sk_ é recusada (400), API não é chamada');

    const orderBefore = lastOrder;
    r = await post(base, { ...validBody, test_secret_key: TEST_SECRET });
    const rawText = await r.text();
    j = JSON.parse(rawText);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.approved, true);
    assert.ok(!('pagarme' in j) && !('test_mode' in j) && !('customer' in j) && !('charges' in j), 'modo teste também não devolve JSON bruto');
    assert.strictEqual(j.tid, '42462901398052');
    assert.strictEqual(lastAuth, 'Basic ' + Buffer.from(TEST_SECRET + ':').toString('base64'), 'usou a chave de teste da requisição, não a do ambiente');
    assert.ok(lastOrder !== orderBefore);
    assert.ok(!rawText.includes(TEST_SECRET), 'segredo de teste não volta na resposta');
    assert.ok(!JSON.stringify(j).includes(TEST_SECRET));
    console.log('✓ modo teste: chave por requisição, só o resumo amigável, segredo não ecoado');

    assert.ok(!app.logs.includes(DUMMY_SECRET), 'segredo de ambiente não aparece nos logs');
    assert.ok(!app.logs.includes(TEST_SECRET), 'segredo de teste não aparece nos logs');
    console.log('✓ chaves secretas não aparecem nos logs do servidor');
  } finally { app.kill(); }

  const noKey = start(4601, { PAGARME_SECRET_KEY: '', PAGARME_API_BASE: 'http://127.0.0.1:4599' });
  try {
    await waitUp('http://127.0.0.1:4601/healthz');
    mode = 'paid';
    let r = await post('http://127.0.0.1:4601', validBody);
    assert.strictEqual(r.status, 503);
    console.log('✓ sem PAGARME_SECRET_KEY e sem chave de teste -> 503, sem chamar a API');

    r = await post('http://127.0.0.1:4601', { ...validBody, test_secret_key: TEST_SECRET });
    const rawText = await r.text();
    const j = JSON.parse(rawText);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.approved, true);
    assert.ok(!('pagarme' in j) && !('test_mode' in j) && !('charges' in j), 'sem JSON bruto mesmo usando chave de teste');
    assert.strictEqual(lastAuth, 'Basic ' + Buffer.from(TEST_SECRET + ':').toString('base64'));
    assert.ok(!rawText.includes(TEST_SECRET));
    assert.ok(!noKey.logs.includes(TEST_SECRET), 'segredo de teste não aparece nos logs (instância sem env)');
    console.log('✓ sem env, chave de teste na requisição autoriza o pagamento (só aquela chamada)');
  } finally { noKey.kill(); mock.close(); }
  console.log('\nSMOKE TEST OK');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
