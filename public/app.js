(() => {
  'use strict';

  // Chave PÚBLICA da Pagar.me (pode ficar no front). A secreta fica só no servidor.
  // No modo teste, a chave pública colada substitui esta na tokenização.
  const PAGARME_PUBLIC_KEY = 'pk_JabK3oRUNgtQY0eV';
  const LS_PK = 'checkout_test_pk';
  const LS_SK = 'checkout_test_sk';

  const $ = (id) => document.getElementById(id);
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const stripAccents = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function testPublicKey() { return ($('test_public_key').value || '').trim(); }
  function testSecretKey() { return ($('test_secret_key').value || '').trim(); }
  function isTestMode() { return !!(testPublicKey() && testSecretKey()); }

  function tokensUrl() {
    const pk = testPublicKey() || PAGARME_PUBLIC_KEY;
    return 'https://api.pagar.me/core/v5/tokens?appId=' + encodeURIComponent(pk);
  }

  // ---------- máscaras ----------
  function mask(el, fn) { el.addEventListener('input', () => { el.value = fn(el.value); el.classList.remove('invalid'); }); }

  function amountCents() { return parseInt(digits($('amount').value) || '0', 10); }
  mask($('amount'), (v) => {
    const c = parseInt(digits(v).slice(0, 9) || '0', 10);
    return c ? (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
  });
  mask($('document'), (v) => digits(v).slice(0, 11)
    .replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'));
  mask($('phone'), (v) => {
    const d = digits(v).slice(0, 11);
    if (d.length <= 2) return d ? '(' + d : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  });
  mask($('zip_code'), (v) => digits(v).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'));
  mask($('card_exp'), (v) => digits(v).slice(0, 4).replace(/(\d{2})(\d)/, '$1/$2'));
  mask($('card_cvv'), (v) => digits(v).slice(0, 4));
  mask($('state'), (v) => v.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase());
  mask($('statement_descriptor'), (v) => stripAccents(v).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 13));
  mask($('holder_name'), (v) => stripAccents(v).toUpperCase().replace(/[^A-Z ]/g, ''));

  function fill(id, value) {
    const el = $(id);
    el.value = value == null ? '' : String(value);
    el.dispatchEvent(new Event('input'));
  }

  // ---------- bandeira ----------
  function detectBrand(n) {
    if (/^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(n)) return 'elo';
    if (/^(606282|3841)/.test(n)) return 'hipercard';
    if (/^3[47]/.test(n)) return 'amex';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'mastercard';
    if (/^4/.test(n)) return 'visa';
    return '';
  }
  const BRAND_LABEL = { visa: 'VISA', mastercard: 'MASTERCARD', elo: 'ELO', amex: 'AMEX', hipercard: 'HIPERCARD' };

  function luhn(n) {
    let sum = 0, alt = false;
    for (let i = n.length - 1; i >= 0; i--) {
      let d = +n[i];
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return n.length >= 13 && sum % 10 === 0;
  }

  mask($('card_number'), (v) => {
    const d = digits(v).slice(0, 19);
    return detectBrand(d) === 'amex'
      ? d.replace(/(\d{4})(\d{0,6})(\d{0,5})/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' '))
      : d.replace(/(\d{4})(?=\d)/g, '$1 ');
  });

  function updatePreview() {
    const n = digits($('card_number').value);
    const brand = detectBrand(n);
    $('cc-preview').className = 'cc-preview ' + brand;
    $('cc-brand').textContent = BRAND_LABEL[brand] || 'CARTÃO';
    $('cc-number-preview').textContent = n ? $('card_number').value : '•••• •••• •••• ••••';
    $('cc-holder-preview').textContent = $('holder_name').value || 'NOME NO CARTÃO';
    $('cc-exp-preview').textContent = $('card_exp').value || 'MM/AA';
  }
  ['card_number', 'holder_name', 'card_exp'].forEach((id) => $(id).addEventListener('input', updatePreview));

  // ---------- parcelas / total ----------
  function updateTotal() {
    const c = amountCents();
    $('pay-total').textContent = brl(c);
    const sel = $('installments');
    const prev = sel.value || '1';
    sel.innerHTML = '';
    const max = Math.max(1, Math.min(12, Math.floor(c / 500) || 1)); // parcela mínima R$ 5
    for (let i = 1; i <= max; i++) {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = i === 1 ? `1x de ${brl(c)}` : `${i}x de ${brl(Math.ceil(c / i))}`;
      sel.appendChild(o);
    }
    sel.value = +prev <= max ? prev : '1';
  }
  $('amount').addEventListener('input', updateTotal);
  updateTotal();

  // ---------- validação ----------
  function isValidCPF(cpf) {
    cpf = digits(cpf);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    const calc = (len) => { let s = 0; for (let i = 0; i < len; i++) s += +cpf[i] * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return calc(9) === +cpf[9] && calc(10) === +cpf[10];
  }

  function validate() {
    const errs = [];
    const bad = (id, msg) => { $(id).classList.add('invalid'); errs.push(msg); };
    document.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));

    const pk = testPublicKey();
    const sk = testSecretKey();
    if ((pk && !sk) || (!pk && sk)) {
      bad(pk ? 'test_secret_key' : 'test_public_key', 'Preencha as duas chaves de teste ou deixe as duas em branco.');
    }
    if (pk && !/^pk_[A-Za-z0-9_-]+$/.test(pk)) bad('test_public_key', 'A chave pública deve começar com pk_.');
    if (sk && !/^sk_[A-Za-z0-9_-]+$/.test(sk)) bad('test_secret_key', 'A chave secreta deve começar com sk_.');

    if ($('product_name').value.trim().length < 2) bad('product_name', 'Informe o produto.');
    if (amountCents() < 100) bad('amount', 'Valor mínimo R$ 1,00.');
    if ($('name').value.trim().split(/\s+/).length < 2) bad('name', 'Informe nome e sobrenome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('email').value.trim())) bad('email', 'E-mail inválido.');
    if (!isValidCPF($('document').value)) bad('document', 'CPF inválido.');
    const ph = digits($('phone').value); if (ph.length < 10) bad('phone', 'Celular inválido.');
    if (!luhn(digits($('card_number').value))) bad('card_number', 'Número do cartão inválido.');
    if ($('holder_name').value.trim().length < 3) bad('holder_name', 'Informe o nome impresso no cartão.');
    const [mm, yy] = $('card_exp').value.split('/').map(Number);
    const now = new Date(); const curY = now.getFullYear() % 100; const curM = now.getMonth() + 1;
    if (!mm || mm > 12 || yy === undefined || isNaN(yy) || yy < curY || (yy === curY && mm < curM)) bad('card_exp', 'Validade inválida.');
    const cvvLen = detectBrand(digits($('card_number').value)) === 'amex' ? 4 : 3;
    if (digits($('card_cvv').value).length !== cvvLen) bad('card_cvv', 'CVV inválido.');
    if (digits($('zip_code').value).length !== 8) bad('zip_code', 'CEP inválido.');
    if (!/^[A-Z]{2}$/.test($('state').value)) bad('state', 'UF inválida.');
    if ($('line_1').value.trim().length < 3) bad('line_1', 'Informe o endereço.');
    if ($('city').value.trim().length < 2) bad('city', 'Informe a cidade.');
    return errs;
  }

  function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

  // ---------- tokenização (navegador -> Pagar.me, com chave pública) ----------
  async function tokenizeCard(billing) {
    const [mm, yy] = $('card_exp').value.split('/').map(Number);
    const res = await fetch(tokensUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'card',
        card: {
          number: digits($('card_number').value),
          holder_name: $('holder_name').value.trim(),
          exp_month: mm,
          exp_year: 2000 + yy,
          cvv: digits($('card_cvv').value),
          billing_address: billing,
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) {
      const detail = body && body.errors ? Object.values(body.errors).flat().join(' ') : (body.message || '');
      throw new Error('Não foi possível validar o cartão. Confira os dados.' + (detail ? ' (' + detail + ')' : ''));
    }
    return body.id; // token_xxx
  }

  // ---------- envio ----------
  $('checkout').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showError('');
    const errs = validate();
    if (errs.length) { showError(errs.join(' ')); document.querySelector('.invalid')?.focus(); return; }

    const btn = $('pay-btn');
    btn.disabled = true;
    btn.firstChild.textContent = 'Processando… ';

    const billing = {
      line_1: $('line_1').value.trim(),
      zip_code: digits($('zip_code').value),
      city: $('city').value.trim(),
      state: $('state').value,
      country: 'BR',
    };

    try {
      const cardToken = await tokenizeCard(billing);
      // A partir daqui só o token segue. Limpa número e CVV da tela.
      $('card_number').value = ''; $('card_cvv').value = ''; updatePreview();

      const payload = {
        product_name: $('product_name').value.trim(),
        amount: amountCents(),
        installments: +$('installments').value || 1,
        statement_descriptor: $('statement_descriptor').value || 'LOJA',
        card_token: cardToken,
        customer: {
          name: $('name').value.trim(),
          email: $('email').value.trim(),
          document: digits($('document').value),
          phone: digits($('phone').value),
        },
        billing_address: billing,
      };
      const sk = testSecretKey();
      if (sk) payload.test_secret_key = sk;

      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Não foi possível concluir o pagamento.');
      showResult(data);
    } catch (err) {
      showError(err.message || 'Erro inesperado.');
    } finally {
      btn.disabled = false;
      btn.firstChild.textContent = 'Pagar ';
    }
  });

  function showResult(r) {
    $('checkout').hidden = true;
    $('result').hidden = false;
    const icon = $('result-icon');
    icon.className = 'result-icon ' + (r.approved ? 'ok' : r.pending ? 'wait' : 'bad');
    icon.textContent = r.approved ? '✓' : r.pending ? '…' : '✕';
    $('result-title').textContent = r.title;
    $('result-message').textContent = r.approved
      ? 'Obrigado! Seu pagamento foi confirmado.'
      : r.message;
    const rows = [
      ['Pedido', r.order_code],
      ['Produto', r.product],
      ['Valor', brl(r.amount)],
      ['Parcelas', r.installments ? r.installments + 'x' : null],
      ['Cartão', r.card_brand && r.card_last4 ? `${r.card_brand} final ${r.card_last4}` : null],
      ['Nome na fatura', r.statement_descriptor],
      ['Autorização', r.auth_code],
      ['TID', r.tid],
    ];
    const dl = $('result-details');
    dl.innerHTML = '';
    rows.filter(([, v]) => v).forEach(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('new-btn').addEventListener('click', () => {
    $('result').hidden = true;
    $('checkout').hidden = false;
    $('checkout').reset();
    $('statement_descriptor').value = 'LOJA';
    restoreTestKeys();
    updatePreview(); updateTotal();
    fillFakeData();
  });

  // ---------- chaves de teste (só no navegador) ----------
  function restoreTestKeys() {
    try {
      const pk = localStorage.getItem(LS_PK) || '';
      const sk = localStorage.getItem(LS_SK) || '';
      $('test_public_key').value = pk;
      $('test_secret_key').value = sk;
    } catch { /* private mode */ }
  }
  function persistTestKeys() {
    try {
      localStorage.setItem(LS_PK, testPublicKey());
      localStorage.setItem(LS_SK, testSecretKey());
    } catch { /* private mode */ }
  }
  ['test_public_key', 'test_secret_key'].forEach((id) => {
    $(id).addEventListener('input', persistTestKeys);
    $(id).addEventListener('change', persistTestKeys);
  });

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const num = btn.getAttribute('data-copy') || '';
      if (!num) return;
      try { await navigator.clipboard.writeText(num); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = num; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      const prev = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = prev; }, 1400);
    });
  });

  // ---------- dados fictícios (F5 = nova pessoa; cartão nunca é preenchido) ----------
  const FIRST_NAMES = ['Ana', 'Bruno', 'Camila', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'Joao', 'Larissa', 'Marcos', 'Natalia', 'Otavio', 'Patricia', 'Rafael', 'Sabrina', 'Thiago', 'Vanessa', 'William'];
  const LAST_NAMES = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Lima', 'Araujo', 'Fernandes', 'Carvalho', 'Gomes', 'Martins', 'Rocha', 'Barbosa', 'Ribeiro', 'Alves', 'Mendes'];
  const PRODUCTS = ['Assinatura mensal', 'Curso online', 'Consultoria', 'Plano Essencial', 'Kit mensal', 'Mentoria individual', 'Licenca anual', 'Workshop', 'Pacote premium', 'Plano Familia', 'Suporte tecnico', 'E-book + comunidade'];
  const DDDS = ['11', '21', '31', '41', '47', '51', '61', '71', '81', '85'];
  const PLACES = [
    { city: 'Sao Paulo', state: 'SP', zip: '01310100', street: 'Avenida Paulista', neighborhood: 'Bela Vista' },
    { city: 'Sao Paulo', state: 'SP', zip: '05433000', street: 'Rua Teodoro Sampaio', neighborhood: 'Pinheiros' },
    { city: 'Rio de Janeiro', state: 'RJ', zip: '22041080', street: 'Avenida Atlantica', neighborhood: 'Copacabana' },
    { city: 'Belo Horizonte', state: 'MG', zip: '30130100', street: 'Avenida Afonso Pena', neighborhood: 'Centro' },
    { city: 'Curitiba', state: 'PR', zip: '80010000', street: 'Rua XV de Novembro', neighborhood: 'Centro' },
    { city: 'Porto Alegre', state: 'RS', zip: '90010191', street: 'Rua dos Andradas', neighborhood: 'Centro Historico' },
    { city: 'Salvador', state: 'BA', zip: '40020000', street: 'Avenida Sete de Setembro', neighborhood: 'Centro' },
    { city: 'Recife', state: 'PE', zip: '50010240', street: 'Avenida Conde da Boa Vista', neighborhood: 'Boa Vista' },
    { city: 'Fortaleza', state: 'CE', zip: '60150000', street: 'Avenida Beira Mar', neighborhood: 'Meireles' },
    { city: 'Brasilia', state: 'DF', zip: '70040902', street: 'Eixo Monumental', neighborhood: 'Zona Civico-Administrativa' },
    { city: 'Manaus', state: 'AM', zip: '69005040', street: 'Avenida Eduardo Ribeiro', neighborhood: 'Centro' },
    { city: 'Campinas', state: 'SP', zip: '13010111', street: 'Avenida Francisco Glicerio', neighborhood: 'Centro' },
    { city: 'Florianopolis', state: 'SC', zip: '88015200', street: 'Rua Felipe Schmidt', neighborhood: 'Centro' },
    { city: 'Goiania', state: 'GO', zip: '74013010', street: 'Avenida Goias', neighborhood: 'Setor Central' },
    { city: 'Belem', state: 'PA', zip: '66010000', street: 'Avenida Presidente Vargas', neighborhood: 'Campina' },
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function generateCPF() {
    const n = [];
    for (let i = 0; i < 9; i++) n.push(randInt(0, 9));
    if (n.every((d) => d === n[0])) n[0] = (n[0] + 1) % 10;
    const calc = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += n[i] * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    n.push(calc(9));
    n.push(calc(10));
    const cpf = n.join('');
    return isValidCPF(cpf) ? cpf : generateCPF();
  }

  function generatePhone() {
    return pick(DDDS) + '9' + String(randInt(10000000, 99999999));
  }

  function slug(s) {
    return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  }

  function localPerson() {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    return { first, last, email: `${slug(first)}.${slug(last)}.${randInt(100, 999)}@exemplo.com` };
  }

  async function fetchPerson() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch('https://randomuser.me/api/?nat=br', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('fail');
      const j = await r.json();
      const u = j && j.results && j.results[0];
      if (!u || !u.name) throw new Error('fail');
      const first = String(u.name.first || '').trim();
      const last = String(u.name.last || '').trim();
      if (!first || !last) throw new Error('fail');
      const email = typeof u.email === 'string' && u.email.includes('@')
        ? u.email
        : `${slug(first)}.${slug(last)}.${randInt(100, 999)}@exemplo.com`;
      return { first, last, email };
    } catch {
      return localPerson();
    }
  }

  async function fillFakeData() {
    const person = await fetchPerson();
    const name = `${person.first} ${person.last}`;
    const place = pick(PLACES);
    const number = randInt(10, 2500);
    const amount = randInt(1500, 25000); // R$ 15,00 a R$ 250,00
    const product = pick(PRODUCTS);

    fill('product_name', product);
    fill('amount', String(amount));
    fill('name', name);
    fill('email', person.email);
    fill('document', generateCPF());
    fill('phone', generatePhone());
    fill('zip_code', place.zip);
    fill('state', place.state);
    fill('line_1', `${number}, ${place.street}, ${place.neighborhood}`);
    fill('city', place.city);
    fill('holder_name', name);
    fill('statement_descriptor', 'LOJA');
    // Cartão (número, validade, CVV) propositalmente vazio — é o único dado digitado à mão.
    $('card_number').value = '';
    $('card_exp').value = '';
    $('card_cvv').value = '';
    updatePreview();
    updateTotal();
  }

  $('gen-data-btn').addEventListener('click', () => { fillFakeData(); });

  restoreTestKeys();
  fillFakeData();
})();
