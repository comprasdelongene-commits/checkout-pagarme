# Checkout Pagar.me (v5) com tokenização

Página de checkout em que **o próprio cliente** informa produto, valor, seus dados e o cartão dele.
O cartão é **tokenizado no navegador** direto na Pagar.me com a chave pública; o servidor recebe só o `card_token`
e cria o pedido com a chave secreta (lida apenas da variável de ambiente).

## Fluxo
1. Navegador → `POST https://api.pagar.me/core/v5/tokens?appId=<chave pública>` com `{type:"card", card:{...}}` → recebe `token_xxx`.
2. Navegador limpa número/CVV da tela e envia para `POST /api/pay` só: produto, valor (centavos), parcelas, nome na fatura, dados do cliente, endereço de cobrança e `card_token`.
3. Servidor valida, gera `PED-########` e `SKU-######`, chama `POST /core/v5/orders` (Basic auth = `PAGARME_SECRET_KEY:`) com `operation_type: auth_and_capture` e `antifraud_enabled: false` no topo do pedido.
4. Servidor devolve um resumo limpo (aprovado/recusado, pedido, valor, produto, bandeira + final, autorização/TID) — nunca o JSON bruto no fluxo de produção.

## Modo teste (homologação)
Na seção **Modo teste (homologação)** cole as chaves de *sandbox* (`pk_test_…` e `sk_test_…`). Elas ficam salvas só no `localStorage` do navegador.

- A chave pública de teste substitui a chave pública de produção na tokenização do cartão.
- A chave secreta de teste é enviada **só naquela** chamada a `/api/pay` e usada apenas nela. O servidor **não** grava, **não** loga e **não** devolve essa chave. Só é aceito o prefixo `sk_test_`.
- A cada F5 (ou no botão “Gerar outros dados fictícios”) o formulário é preenchido com dados aleatórios válidos (nome, CPF, e-mail, telefone, endereço, produto e valor). **Só o cartão** (número, validade e CVV) fica para você digitar — há uma lista dos cartões oficiais do [simulador de crédito da Pagar.me](https://docs.pagar.me/docs/simulador-de-cart%C3%A3o-de-cr%C3%A9dito), com botão de copiar.
- A tela de resultado mostra só o resumo amigável (aprovado/recusado, pedido, valor, produto, parcelas, bandeira + final, autorização/TID). O JSON bruto da Pagar.me não é devolvido ao navegador.

Se os dois campos de chave de teste estiverem vazios, o fluxo de produção segue igual ao de sempre (`PAGARME_SECRET_KEY` no servidor).

## Rodar local
```bash
npm install
PAGARME_SECRET_KEY=sk_... npm start   # http://localhost:3000
npm test                               # smoke test com mock local, sem chamadas reais
```

## Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `PAGARME_SECRET_KEY` | sim (produção) | Chave secreta da Pagar.me. Só no servidor. Sem ela, `/api/pay` responde 503 (a menos que uma `sk_test_` seja enviada na requisição). |
| `PORT` | não | Porta (o Render define automaticamente). |
| `PAGARME_API_BASE` | não | Só para testes com mock. Padrão `https://api.pagar.me/core/v5`. |

A chave **pública** de produção fica em `public/app.js` (`PAGARME_PUBLIC_KEY`). Ela pode ser exposta.

## Deploy no Render
Há um `render.yaml` (Blueprint). Suba o projeto num repositório, crie o Blueprint/Web Service no Render e
defina `PAGARME_SECRET_KEY` no painel (está como `sync: false`, então o Render pede o valor).

**Importante:** no painel da Pagar.me, cadastre o domínio do site (ex.: `https://checkout-pagarme.onrender.com`)
nos domínios permitidos da chave pública, senão a tokenização no navegador é bloqueada (CORS).

## Segurança
- Número do cartão e CVV nunca chegam ao servidor (o servidor só aceita `card_token` no formato `token_...`).
- Chave secreta de produção só via `process.env`, nunca logada nem enviada ao front.
- Chave secreta de teste (`sk_test_`) aceita só por requisição, nunca persistida, logada ou ecoada.
- Rate limit: 10 pagamentos / 15 min por IP. Helmet + CSP (`connect-src` só `self`, `api.pagar.me` e `randomuser.me`).
