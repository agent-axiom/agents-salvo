# Telegram Stars Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional one-time Telegram Stars support payments to the Telegram Mini App while keeping the website and Android/iOS applications free of payment controls and preserving one shared gameplay codebase.

**Architecture:** The shared application renders a Telegram-only support modal through a small platform capability and a bounded frontend client. A Cloudflare Worker creates owner-bound invoices, validates Telegram webhook updates, and stores authoritative payment receipts in a private D1 table; only `successful_payment` can move an invoice to `paid`.

**Tech Stack:** ES modules, esbuild, Node.js 24 test runner and coverage, Telegram Mini Apps JavaScript API, Telegram Bot API, Cloudflare Workers, D1, GitHub Pages, Capacitor 8.

---

## File Map

**Create**

- `migrations/0004_star_support_payments.sql`: constrained invoice and receipt storage.
- `worker/telegram-bot-api.js`: bounded, redacted Telegram Bot API client.
- `worker/stars-support.js`: invoice lifecycle, webhook validation, and bot command responses.
- `tests/telegram-bot-api.test.mjs`: Bot API request, timeout, bounds, and redaction tests.
- `tests/stars-support-worker.test.mjs`: D1 lifecycle, route, ownership, webhook, and idempotency tests.
- `src/stars-support.js`: strict frontend invoice/status client and bounded polling.
- `tests/stars-support.test.mjs`: frontend client validation, timeout, cancellation, and polling tests.
- `src/support.html`: localized public support terms in English, Russian, and Chinese.
- `scripts/configure-telegram-stars-webhook.mjs`: explicit, secret-safe webhook registration and verification command.
- `tests/telegram-stars-webhook-script.test.mjs`: webhook script request and redaction tests.

**Modify**

- `worker/index.js`: exact invoice/status/webhook routing, authorization, strict CORS handling, and dependency wiring.
- `src/platform/telegram.js`: expose native invoice capability and normalized callback states.
- `src/platform/web.js`: expose unsupported invoice capability.
- `src/platform/native.js`: expose unsupported invoice capability.
- `tests/platform.test.mjs`: enforce platform contract parity.
- `tests/telegram-platform.test.mjs`: cover invoice callback and provider failure normalization.
- `src/app.js`: Telegram-only support entry, modal state machine, confirmation, focus management, and status recovery.
- `src/styles.css`: compact settings row, responsive accessible modal, amount controls, and live status styles.
- `src/i18n.js`: support-payment UI strings in RU/EN/ZH.
- `tests/app-behavior.test.mjs`: register support modal behavior scenarios.
- `tests/app-behavior-harness.mjs`: exercise visibility, validation, invoice flow, focus, and authoritative confirmation.
- `tests/i18n.test.mjs`: require support translation parity.
- `src/privacy.html`: disclose minimal payment processing and retention in all locales.
- `tests/privacy.test.mjs`: verify terms, privacy, support contact, and build publication.
- `scripts/build.mjs`: continue publishing the new static terms page through the shared source copy.
- `tests/telegram-build.test.mjs`: assert the terms page and one shared application bundle are emitted.
- `package.json`: include Stars route tests in the critical Worker coverage gate and add webhook configuration commands.
- `wrangler.toml`: document the required secret without committing a value.
- `README.md`, `README.ru.md`, `README.zh-CN.md`: document Stars behavior, support commands, secrets, migration, webhook, and verification.

## Task 1: Add the Constrained D1 Payment Model

**Files:**
- Create: `migrations/0004_star_support_payments.sql`
- Create: `tests/stars-support-worker.test.mjs`

- [ ] **Step 1: Write a migration contract test**

Create a SQLite-backed D1 harness that loads migrations `0001`, `0003`, and
`0004`, then assert the database accepts one valid pending invoice:

```js
db.database.prepare(`
  INSERT INTO star_support_payments (
    invoice_id, invoice_payload, user_key, telegram_user_id,
    amount, currency, status, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, 'XTR', 'pending', ?, ?)
`).run(
  "inv_AAAAAAAAAAAAAAAAAAAAAA",
  "pay_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "telegram:8710001168",
  "8710001168",
  88,
  1784332800,
  1784333700,
);
```

Assert that duplicate invoice IDs, duplicate payloads, duplicate non-null charge
IDs, amount `0`, amount `10001`, non-`XTR` currency, unknown statuses, paid rows
without `paid_at`, and expiry before creation fail with SQLite constraints.

- [ ] **Step 2: Run the focused test and confirm the missing migration failure**

Run:

```sh
node --test tests/stars-support-worker.test.mjs
```

Expected: FAIL because `migrations/0004_star_support_payments.sql` does not
exist.

- [ ] **Step 3: Implement the migration**

Create the table with server-only columns and explicit checks:

```sql
CREATE TABLE IF NOT EXISTS star_support_payments (
  invoice_id TEXT PRIMARY KEY,
  invoice_payload TEXT NOT NULL UNIQUE,
  user_key TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000),
  currency TEXT NOT NULL DEFAULT 'XTR' CHECK (currency = 'XTR'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  paid_at INTEGER,
  failed_at INTEGER,
  refunded_at INTEGER,
  telegram_payment_charge_id TEXT UNIQUE,
  CHECK ((status = 'paid' AND paid_at IS NOT NULL AND telegram_payment_charge_id IS NOT NULL)
      OR status <> 'paid')
);

CREATE INDEX IF NOT EXISTS idx_star_support_owner_created
  ON star_support_payments(user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_star_support_expiry
  ON star_support_payments(status, expires_at);
```

Do not add a foreign key to public profile or leaderboard tables. The table is
private payment infrastructure, not player progression.

- [ ] **Step 4: Run the migration tests**

Run:

```sh
node --test tests/stars-support-worker.test.mjs
```

Expected: PASS for migration constraints; later route tests remain skipped only
until their task introduces them.

- [ ] **Step 5: Commit the payment model**

```sh
git add migrations/0004_star_support_payments.sql tests/stars-support-worker.test.mjs
git commit -m "feat: add Telegram Stars payment records"
```

## Task 2: Build a Strict Telegram Bot API Client

**Files:**
- Create: `worker/telegram-bot-api.js`
- Create: `tests/telegram-bot-api.test.mjs`

- [ ] **Step 1: Write the invoice-link request test**

Exercise an injected `fetcher` and assert an exact HTTPS POST to Telegram:

```js
const client = createTelegramBotApiClient({
  botToken: "123456:test-token",
  fetcher: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: "https://t.me/$invoice" }));
  },
});

assert.equal(await client.createInvoiceLink({
  title: "Support Salvo",
  description: "Voluntary support with no gameplay benefits.",
  payload: "pay_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  amount: 88,
}), "https://t.me/$invoice");
assert.deepEqual(calls[0].body, {
  title: "Support Salvo",
  description: "Voluntary support with no gameplay benefits.",
  payload: "pay_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  currency: "XTR",
  prices: [{ label: "Support Salvo", amount: 88 }],
});
```

Assert `provider_token`, tips, subscription period, user contact, shipping, and
external payment fields are absent.

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run:

```sh
node --test tests/telegram-bot-api.test.mjs
```

Expected: FAIL because `worker/telegram-bot-api.js` does not exist.

- [ ] **Step 3: Implement the bounded client**

Export `createTelegramBotApiClient({ botToken, fetcher = fetch, timeoutMs =
4000, maxResponseBytes = 64 * 1024 })` with methods:

```js
return {
  createInvoiceLink(invoice) {
    return call("createInvoiceLink", invoiceRequest(invoice), isInvoiceUrl);
  },
  answerPreCheckoutQuery({ id, ok, errorMessage }) {
    return call("answerPreCheckoutQuery", {
      pre_checkout_query_id: id,
      ok,
      ...(ok ? {} : { error_message: errorMessage }),
    }, (value) => value === true);
  },
  sendMessage({ chatId, text }) {
    return call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, isTelegramMessage);
  },
};
```

The common `call` must:

- require a non-empty bot token without exposing it;
- construct only `https://api.telegram.org/bot${token}/${method}` internally;
- use `AbortSignal.timeout(timeoutMs)` or an injected timer-compatible signal;
- reject non-2xx responses, invalid JSON, `ok !== true`, invalid result shapes,
  and bodies exceeding `maxResponseBytes`;
- throw only `new Error("Telegram Bot API request failed")` externally;
- never include provider response text, URL, token, payload, or charge IDs in
  errors.

- [ ] **Step 4: Add adversarial Bot API tests**

Cover missing/blank token, unsafe method names, invalid amount/title/payload,
timeout, network rejection, HTTP 500 containing a secret, malformed JSON,
oversized body, `ok: false`, wrong result shape, and a fetcher that throws a
secret-bearing error. Also assert `answerPreCheckoutQuery` and `sendMessage`
request bodies exactly.

- [ ] **Step 5: Run Bot API tests with coverage**

Run:

```sh
node --experimental-test-coverage \
  --test-coverage-include=worker/telegram-bot-api.js \
  --test-coverage-lines=98 \
  --test tests/telegram-bot-api.test.mjs
```

Expected: PASS with at least 98% line coverage.

- [ ] **Step 6: Commit the Bot API client**

```sh
git add worker/telegram-bot-api.js tests/telegram-bot-api.test.mjs
git commit -m "feat: add bounded Telegram Bot API client"
```

## Task 3: Implement Invoice Creation and Owner-Only Status Reads

**Files:**
- Create: `worker/stars-support.js`
- Modify: `tests/stars-support-worker.test.mjs`

- [ ] **Step 1: Write invoice creation tests**

Import `createStarsSupportService` with injected D1, Bot API, clock, and random
bytes. Cover presets and custom values through the same domain API:

```js
const service = createStarsSupportService({
  db,
  botApi,
  now: () => 1784332800,
  randomBytes: deterministicRandomBytes,
});

const invoice = await service.createInvoice({
  user: { provider: "telegram", id: "8710001168", userKey: "telegram:8710001168" },
  amount: 88,
  locale: "ru",
});

assert.deepEqual(invoice, {
  invoiceId: "inv_AAAAAAAAAAAAAAAAAAAAAA",
  invoiceUrl: "https://t.me/$invoice",
  amount: 88,
  currency: "XTR",
  expiresAt: "2026-07-17T20:15:00.000Z",
});
```

Assert the Bot API receives server-owned localized title, description, label,
opaque payload, `XTR`, and one integer price. Assert the D1 row exists before
the fake Bot API is invoked.

- [ ] **Step 2: Add validation and failure tests**

Reject fractional, string, zero, negative, over-10,000, `NaN`, unsafe locale,
non-Telegram identities, missing DB, and malformed user keys. On Bot API
failure, assert the already-created row becomes `failed` with `failed_at`, and
the public error is redacted.

- [ ] **Step 3: Run the focused tests and confirm the missing service failure**

Run:

```sh
node --test tests/stars-support-worker.test.mjs
```

Expected: FAIL because `worker/stars-support.js` does not exist.

- [ ] **Step 4: Implement invoice creation**

Export constants and service construction:

```js
export const starsAmountLimits = Object.freeze({ min: 1, max: 10_000 });
export const starsInvoiceTtlSeconds = 15 * 60;

export function createStarsSupportService({ db, botApi, now, randomBytes }) {
  return {
    createInvoice: (input) => createInvoice(dependencies, input),
    getInvoice: (input) => getInvoice(dependencies, input),
    handleUpdate: (update) => handleUpdate(dependencies, update),
  };
}
```

Generate independent base64url identifiers with fixed prefixes. The public
invoice ID and private payload must each fit their documented bounds and must
not be derivable from user identity or amount. Insert `pending` before calling
Telegram, then mark `failed` conditionally on provider failure.

Use an explicit translation table keyed by `en`, `ru`, and `zh`; normalize
`zh-CN` to `zh` only at the HTTP boundary, not in stored data.

- [ ] **Step 5: Write and implement owner-only status reads**

Add tests for a matching owner, a different authenticated owner, unknown IDs,
expired pending rows, failed rows, and paid rows. Public output must be exactly:

```js
{
  invoiceId,
  amount: 88,
  currency: "XTR",
  status: "pending", // pending | paid | expired | failed
  createdAt: "2026-07-17T20:00:00.000Z",
  expiresAt: "2026-07-17T20:15:00.000Z",
  paidAt: null,
}
```

Never include `invoice_payload`, `user_key`, `telegram_user_id`,
`telegram_payment_charge_id`, or refund fields. Map an expired pending row to
public `expired` without accepting checkout; a best-effort conditional cleanup
may mark it failed internally.

- [ ] **Step 6: Run service tests with coverage**

Run:

```sh
node --experimental-test-coverage \
  --test-coverage-include=worker/stars-support.js \
  --test-coverage-lines=98 \
  --test tests/stars-support-worker.test.mjs
```

Expected: PASS with at least 98% line coverage.

- [ ] **Step 7: Commit the invoice domain**

```sh
git add worker/stars-support.js tests/stars-support-worker.test.mjs
git commit -m "feat: create owner-bound Stars invoices"
```

## Task 4: Validate Pre-Checkout and Store Authoritative Payments

**Files:**
- Modify: `worker/stars-support.js`
- Modify: `tests/stars-support-worker.test.mjs`

- [ ] **Step 1: Write valid pre-checkout tests**

Seed a pending invoice and pass a Telegram update with:

```js
{
  update_id: 1001,
  pre_checkout_query: {
    id: "pcq_1",
    from: { id: 8710001168, language_code: "ru" },
    currency: "XTR",
    total_amount: 88,
    invoice_payload: storedPayload,
  },
}
```

Assert `answerPreCheckoutQuery({ id: "pcq_1", ok: true })` is called once and
the payment remains pending.

- [ ] **Step 2: Write rejection matrix tests**

For each case, assert Telegram receives `ok: false` with a short localized
message and D1 is unchanged:

- unknown payload;
- expired invoice;
- wrong payer;
- wrong integer amount;
- wrong currency;
- failed, paid, or refunded row;
- malformed query ID or sender;
- duplicate keys or extra unsupported payment structures.

Provider timeout must remain redacted and produce a retryable handler failure,
not a false webhook success.

- [ ] **Step 3: Implement pre-checkout validation**

The service must load by private payload, compare exact payer/currency/amount,
and check `created_at <= now < expires_at` and `status === "pending"`. It must
always attempt `answerPreCheckoutQuery` for a structurally valid query. Keep the
Bot API timeout under Telegram's ten-second deadline; the client default remains
four seconds.

- [ ] **Step 4: Write successful-payment tests**

Seed a pending invoice, then process:

```js
{
  update_id: 1002,
  message: {
    message_id: 77,
    date: 1784332860,
    chat: { id: 8710001168, type: "private" },
    from: { id: 8710001168, language_code: "ru" },
    successful_payment: {
      currency: "XTR",
      total_amount: 88,
      invoice_payload: storedPayload,
      telegram_payment_charge_id: "charge_opaque_1",
      provider_payment_charge_id: "",
    },
  },
}
```

Assert a conditional update sets `status = 'paid'`, `paid_at`, and the Telegram
charge ID. Assert the public status now reports `paid`.

- [ ] **Step 5: Add idempotency and conflict tests**

Cover exact update redelivery, duplicate charge ID on the same row, duplicate
charge ID on another invoice, different charge on an already-paid invoice,
wrong user, amount, currency, payload, malformed charge ID, missing sender, and
D1 failure. Exact redelivery returns success without another mutation. Any
conflict fails closed; a transient D1 failure must be surfaced so Telegram can
redeliver.

- [ ] **Step 6: Implement successful payment handling**

Use a conditional update that matches payload, pending status, owner,
currency, and amount. If no row changes, load the row and accept only an exact
already-paid duplicate with the same charge ID and values. Never trust
`provider_payment_charge_id`, never create a row from a webhook, and never mark
paid from an invoice callback.

- [ ] **Step 7: Run payment-state tests**

Run:

```sh
node --test tests/stars-support-worker.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit authoritative payment processing**

```sh
git add worker/stars-support.js tests/stars-support-worker.test.mjs
git commit -m "feat: verify Telegram Stars payments"
```

## Task 5: Route Invoice APIs and Authenticate the Telegram Webhook

**Files:**
- Modify: `worker/index.js`
- Modify: `tests/stars-support-worker.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write exact route and method tests**

Add Worker-level requests for:

```text
POST /payments/stars/invoices
GET  /payments/stars/invoices/:invoiceId
POST /telegram/webhook
```

Assert trailing slashes, mixed case, extra segments, wrong methods, malformed
IDs, and webhook `OPTIONS` all return 404. The webhook response must not carry
`Access-Control-Allow-Origin`; browser invoice/status responses retain the
existing CORS policy.

- [ ] **Step 2: Write authorization and strict-body tests**

For invoice creation/status, cover missing, malformed, expired, and wrong-owner
bearer sessions. For invoice creation, require `application/json`, exactly
`amount` and `locale`, and a bounded body. Reject unknown fields, duplicate JSON
keys through strict parsing, malformed JSON, and oversized bodies.

For webhook, require exact `Content-Type: application/json`, a bounded body,
and exact `X-Telegram-Bot-Api-Secret-Token`. Cover missing DB/token/webhook
secret, blank secret, missing header, wrong length, wrong value, malformed JSON,
oversized bodies, and secret-bearing internal errors. All public failures are
redacted.

- [ ] **Step 3: Run tests and confirm the routes return 404**

Run:

```sh
node --test tests/stars-support-worker.test.mjs
```

Expected: FAIL because the Worker has no Stars routes.

- [ ] **Step 4: Add exact route parsing**

Extend `routeRequest` with strict shapes:

```js
if (url.pathname === "/payments/stars/invoices") {
  return { kind: "starsInvoiceCreate" };
}
if (
  parts.length === 4
  && parts[0] === "payments"
  && parts[1] === "stars"
  && parts[2] === "invoices"
  && /^[A-Za-z0-9_-]{8,64}$/.test(parts[3])
) {
  return { kind: "starsInvoiceStatus", invoiceId: parts[3] };
}
if (url.pathname === "/telegram/webhook") {
  return { kind: "telegramWebhook" };
}
```

Route webhook before the global browser `OPTIONS` response so it cannot inherit
permissive CORS. Add a `webhookJson` response helper with only content type and
no browser headers.

- [ ] **Step 5: Wire service dependencies and handlers**

Construct the Bot API client and Stars service only inside matched handlers.
Derive the private user key from the session-resolved identity rather than any
request field. Return explicit public status codes:

- `201` invoice created;
- `200` status/webhook success;
- `400` invalid bounded input;
- `401` session failure;
- `403` webhook secret failure or wrong owner;
- `404` unknown invoice/exact-route mismatch;
- `503` unavailable D1/Bot API configuration.

Implement constant-time webhook secret comparison over UTF-8 bytes and fail
closed if `TELEGRAM_WEBHOOK_SECRET` is absent. Do not reuse `SESSION_SECRET` or
the bot token as the webhook secret.

- [ ] **Step 6: Add command update tests and implementation**

Handle only private-chat `/terms`, `/support`, and `/paysupport`, with optional
`@agents_salvo_bot` suffix. Use RU/EN/ZH text selected from the Telegram sender
language. `/terms` links to:

```text
https://agent-axiom.github.io/agents-salvo/support.html
```

Support commands link to GitHub Issues, say Telegram Support cannot resolve the
purchase, and warn users not to publish session tokens, invoice payloads, or
charge IDs. Other updates return `{ ok: true }` without Bot API calls.

- [ ] **Step 7: Add Stars tests to critical Worker coverage**

Modify `coverage:critical:worker` so `tests/stars-support-worker.test.mjs` runs
with the existing Worker gate. Do not lower the 98% threshold.

- [ ] **Step 8: Run Worker tests and coverage**

Run:

```sh
npm run coverage:critical:worker
```

Expected: PASS at 98%+ lines for `worker/index.js`.

- [ ] **Step 9: Commit Worker routing**

```sh
git add worker/index.js worker/stars-support.js tests/stars-support-worker.test.mjs package.json
git commit -m "feat: expose secure Stars payment endpoints"
```

## Task 6: Add the Cross-Platform Invoice Capability

**Files:**
- Modify: `src/platform/telegram.js`
- Modify: `src/platform/web.js`
- Modify: `src/platform/native.js`
- Modify: `tests/platform.test.mjs`
- Modify: `tests/telegram-platform.test.mjs`

- [ ] **Step 1: Write platform contract parity tests**

Extend the adapter contract assertion with:

```js
assert.equal(typeof adapter.supportsInvoice, "function");
assert.equal(typeof adapter.openInvoice, "function");
```

Assert web and native return `false` from `supportsInvoice()` and
`{ status: "unsupported" }` from `openInvoice(...)` without opening a browser.

- [ ] **Step 2: Write Telegram invoice callback tests**

Create a fake `WebApp.openInvoice(url, callback)` and cover `paid`, `pending`,
`cancelled`, and `failed`. Assert the adapter resolves exactly one normalized
result and ignores duplicate callbacks:

```js
assert.deepEqual(
  await adapter.openInvoice("https://t.me/$invoice"),
  { status: "paid" },
);
```

Cover absent API, thrown accessors, synchronous throw, callback with an unknown
status, callback omission with timeout, invalid URL, and WebApp version below
the required invoice API version. All fail closed to `unsupported` or `failed`,
without exposing provider errors.

- [ ] **Step 3: Run tests and confirm the capability is missing**

Run:

```sh
node --test tests/platform.test.mjs tests/telegram-platform.test.mjs
```

Expected: FAIL because the adapters do not expose the invoice contract.

- [ ] **Step 4: Implement the adapters**

Web and native:

```js
supportsInvoice: () => false,
openInvoice: async () => ({ status: "unsupported" }),
```

Telegram must use only `Telegram.WebApp.openInvoice` and normalize a single
callback. Require an HTTPS `t.me` invoice URL and a supported WebApp version.
Bound callback waiting with an internal timeout, clear the timer on settlement,
and never call `window.open` as a payment fallback.

- [ ] **Step 5: Run platform tests**

Run:

```sh
node --test tests/platform.test.mjs tests/telegram-platform.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit platform support**

```sh
git add src/platform/telegram.js src/platform/web.js src/platform/native.js tests/platform.test.mjs tests/telegram-platform.test.mjs
git commit -m "feat: open native Telegram Stars invoices"
```

## Task 7: Build the Bounded Frontend Stars Client

**Files:**
- Create: `src/stars-support.js`
- Create: `tests/stars-support.test.mjs`

- [ ] **Step 1: Write strict create/status tests**

Create the client with injected worker URL, fetcher, timeout, and delay. Assert:

```js
const client = createStarsSupportClient({
  workerUrl: "https://worker.test",
  getToken: async () => "session-token",
  fetcher,
});

const invoice = await client.createInvoice({ amount: 88, locale: "ru" });
assert.deepEqual(invoice, {
  invoiceId: "inv_AAAAAAAAAAAAAAAAAAAAAA",
  invoiceUrl: "https://t.me/$invoice",
  amount: 88,
  currency: "XTR",
  expiresAt: "2026-07-17T20:15:00.000Z",
});
```

Assert the request has bearer auth, JSON content type, and exactly `amount` and
`locale`. Status reads must encode only a validated opaque invoice ID.

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run:

```sh
node --test tests/stars-support.test.mjs
```

Expected: FAIL because `src/stars-support.js` does not exist.

- [ ] **Step 3: Implement strict response validation**

Export:

```js
export function createStarsSupportClient(options) {
  return {
    createInvoice,
    getInvoice,
    waitForPaid,
  };
}
```

Validate amount, locale, IDs, `XTR`, HTTPS Telegram invoice URL, ISO timestamps,
public statuses, response content type, and a bounded response body. Use a
generic `Stars support request failed` error; never retain response bodies in
errors.

- [ ] **Step 4: Write polling and cancellation tests**

`waitForPaid(invoiceId, { signal })` must make a bounded number of status reads
with a bounded delay. Cover immediate paid, pending-then-paid, pending timeout,
expired, failed, abort before start, abort during delay, network failure, HTTP
401/403/404/503, malformed JSON, and oversized response. Return:

```js
{ status: "paid", invoice }
{ status: "pending", invoice }
{ status: "expired", invoice }
{ status: "failed", invoice }
```

Do not retry authorization, validation, expired, or failed responses.

- [ ] **Step 5: Run client coverage**

Run:

```sh
node --experimental-test-coverage \
  --test-coverage-include=src/stars-support.js \
  --test-coverage-lines=98 \
  --test tests/stars-support.test.mjs
```

Expected: PASS at 98%+ lines.

- [ ] **Step 6: Commit the frontend client**

```sh
git add src/stars-support.js tests/stars-support.test.mjs
git commit -m "feat: add Stars support frontend client"
```

## Task 8: Add the Telegram-Only Support Modal

**Files:**
- Modify: `src/app.js`
- Modify: `src/styles.css`
- Modify: `src/i18n.js`
- Modify: `tests/app-behavior.test.mjs`
- Modify: `tests/app-behavior-harness.mjs`
- Modify: `tests/i18n.test.mjs`

- [ ] **Step 1: Write visibility and amount-selection scenarios**

Add behavior scenarios proving:

- the support row is absent on web, Android, and iOS;
- it is present only when `getPlatform() === "telegram"` and
  `supportsInvoice() === true`;
- opening the modal selects `88` by default;
- preset buttons select `8`, `88`, and `360`;
- custom input accepts ASCII integer digits only and validates 1 through 10,000;
- fractional, localized digits, exponent notation, signs, whitespace-only,
  zero, and 10,001 do not enable confirmation;
- the terms checkbox is required.

- [ ] **Step 2: Run the behavior test and confirm the UI is absent**

Run:

```sh
node --test tests/app-behavior.test.mjs tests/i18n.test.mjs
```

Expected: FAIL because the support UI and translation keys do not exist.

- [ ] **Step 3: Add isolated modal state**

Add a state branch that never touches game state:

```js
support: {
  open: false,
  step: "amount", // amount | confirm | processing | result
  amount: 88,
  customAmount: "",
  useCustom: false,
  acceptedTerms: false,
  invoiceId: "",
  status: "idle",
  error: "",
},
```

Instantiate the Stars client with the existing Worker URL and secure session
token provider. The support row must render below account controls and above
build metadata only when the runtime capability is available.

- [ ] **Step 4: Render the modal and accessible controls**

Use a `role="dialog"`, `aria-modal="true"`, labelled title, described voluntary
support statement, and `aria-live="polite"` status region. Use star swatches for
amounts, a numeric input with `inputmode="numeric"`, and clear button labels.
The exact selected amount must appear in the final confirmation command.

The terms link points to `/agents-salvo/support.html`, opens normally in the
Mini App through `platform.openExternalUrl`, and does not close the modal.

- [ ] **Step 5: Implement the invoice state machine**

On confirm:

1. prevent re-entry and disable amount controls;
2. create the Worker invoice;
3. call `platform.openInvoice(invoiceUrl)`;
4. on `paid`, poll `waitForPaid` and show thanks only after server `paid`;
5. on polling timeout, show `confirmation pending` and a retry command;
6. on `pending`, show Telegram processing and a retry command;
7. on `cancelled`, return to amount selection without an error;
8. on `failed` or malformed output, retain the amount and show a retryable error;
9. on close, abort active fetch/poll work and ignore late completions.

Authentication or network loss must show a localized, recoverable status and
must not block settings or gameplay.

- [ ] **Step 6: Add focus and lifecycle scenarios**

Test focus moves to the modal title/first control, Tab and Shift+Tab stay inside
the open modal, Escape closes only when no native invoice is active, and close
restores focus to the settings entry button. Test double-click prevention,
closing during fetch, late callback suppression, and reopening after a prior
cancel/failure.

- [ ] **Step 7: Style the Telegram modal**

Add stable responsive dimensions, safe-area padding, no nested decorative
cards, and touch targets at least 44px. Keep the palette consistent with the
paper/ink design, reserve red for errors, and ensure custom amount errors do not
shift surrounding controls. Do not add gradients, monetization banners, badges,
or gameplay overlays.

- [ ] **Step 8: Add all RU/EN/ZH translations**

Add keys for entry, voluntary statement, presets/custom amount, range error,
terms acceptance, confirmation, creating/opening, paid thanks, pending,
cancelled, failed, unavailable, retry, close, and support link. Extend the i18n
parity test so every locale has identical support keys and interpolates the
amount safely.

- [ ] **Step 9: Run behavior and i18n tests**

Run:

```sh
node --test tests/app-behavior.test.mjs tests/i18n.test.mjs tests/auth-ui.test.mjs
```

Expected: PASS.

- [ ] **Step 10: Commit the support UI**

```sh
git add src/app.js src/styles.css src/i18n.js tests/app-behavior.test.mjs tests/app-behavior-harness.mjs tests/i18n.test.mjs
git commit -m "feat: add Telegram-only Stars support UI"
```

## Task 9: Publish Localized Terms and Payment Privacy Disclosures

**Files:**
- Create: `src/support.html`
- Modify: `src/privacy.html`
- Modify: `tests/privacy.test.mjs`
- Modify: `tests/telegram-build.test.mjs`

- [ ] **Step 1: Write terms and privacy contract tests**

Require `src/support.html` sections `ru`, `en`, and `zh-CN`. In every locale,
assert the page explains:

- support is voluntary and buys no gameplay content or advantage;
- the chosen Stars amount is charged once;
- Telegram processes the transaction;
- how to request payment support/refund;
- Telegram Support cannot resolve merchant disputes;
- the GitHub Issues contact;
- users must not publish session tokens, invoice payloads, or charge IDs.

Extend privacy tests to require disclosure of amount, currency, payment status,
Telegram payer ID, charge ID, timestamps, verification/dispute/refund purposes,
and no public profile/leaderboard use in all locales.

- [ ] **Step 2: Run the tests and confirm the terms page is missing**

Run:

```sh
node --test tests/privacy.test.mjs
```

Expected: FAIL because `src/support.html` does not exist.

- [ ] **Step 3: Create the localized terms page**

Use the same restrained static-page design as `privacy.html`, a locale switcher,
an effective date, and canonical links. Avoid claims that payments are tax-
deductible donations or purchases. Use `support` consistently and state that
legitimate refunds are reviewed against Telegram receipts.

- [ ] **Step 4: Update the privacy notice**

Add the minimum payment records and purpose without changing unrelated account,
gameplay, or Mini App disclosures. State payment details are private and not
used for advertising, analytics, rating, matchmaking, badges, or leaderboards.

- [ ] **Step 5: Verify build publication**

The build already copies `src` recursively, so no new copy branch should be
needed. Add a build assertion that `dist/support.html` exists and that the web,
Telegram, Android, and iOS shells still reference one shared hashed JS/CSS pair.

Run:

```sh
node --test tests/privacy.test.mjs tests/telegram-build.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit legal/support content**

```sh
git add src/support.html src/privacy.html tests/privacy.test.mjs tests/telegram-build.test.mjs
git commit -m "docs: publish Telegram Stars support terms"
```

## Task 10: Add Explicit Webhook Configuration and Operations Docs

**Files:**
- Create: `scripts/configure-telegram-stars-webhook.mjs`
- Create: `tests/telegram-stars-webhook-script.test.mjs`
- Modify: `package.json`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Write the webhook script request test**

Run the script against an injected/fake fetch hook and assert it calls
`setWebhook` with exactly:

```js
{
  url: "https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook",
  secret_token: webhookSecret,
  allowed_updates: ["message", "pre_checkout_query"],
  drop_pending_updates: false,
}
```

Then assert it calls `getWebhookInfo` and verifies the exact URL without printing
the bot token, webhook secret, pending update bodies, or provider response body.

- [ ] **Step 2: Run the test and confirm the script is missing**

Run:

```sh
node --test tests/telegram-stars-webhook-script.test.mjs
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement explicit configuration**

Require `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from environment,
validate the Worker webhook URL constant, use bounded HTTPS requests, and print
only a success line containing the public webhook URL. Add package commands:

```json
"telegram:stars:webhook:set": "node scripts/configure-telegram-stars-webhook.mjs set",
"telegram:stars:webhook:check": "node scripts/configure-telegram-stars-webhook.mjs check"
```

Do not auto-run this script during build, test, Pages deploy, native build, or
Worker deploy. Webhook registration is an explicit production operation because
Telegram permits only one webhook per bot.

- [ ] **Step 4: Document deployment and refund operations**

In all three READMEs document this exact order:

```sh
npx wrangler d1 migrations apply agents-salvo-profile --remote
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:stars:webhook:set
npm run telegram:stars:webhook:check
```

Explain how to inspect a receipt privately in D1 and perform a manual legitimate
refund with Telegram `refundStarPayment` using the stored Telegram user ID and
charge ID. Never show a command that commits or echoes secrets. Note that the
real 8-Star smoke test is manual and requires explicit operator action.

- [ ] **Step 5: Document the required Worker secret**

Add only a comment to `wrangler.toml` naming `TELEGRAM_WEBHOOK_SECRET`; do not
add a value or placeholder that could be deployed accidentally.

- [ ] **Step 6: Run script tests**

Run:

```sh
node --test tests/telegram-stars-webhook-script.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit operations support**

```sh
git add scripts/configure-telegram-stars-webhook.mjs tests/telegram-stars-webhook-script.test.mjs package.json wrangler.toml README.md README.ru.md README.zh-CN.md
git commit -m "ops: configure Telegram Stars webhook"
```

## Task 11: Security, Regression, and Release Verification

**Files:**
- Modify only where a failing verification exposes a defect.

- [ ] **Step 1: Scan for forbidden coupling and placeholders**

Run:

```sh
rg -n "TODO|TBD|PLACEHOLDER|provider_token|max_tip_amount|subscription_period" \
  worker src scripts tests README.md README.ru.md README.zh-CN.md
rg -n "star_support|Stars|support" worker src | head -n 300
```

Expected: no TODO/TBD/placeholder remains; forbidden Telegram invoice fields
appear only in negative tests or documentation. Verify payment code has no
imports from game rules, ratings, matchmaking, achievements, or replay modules.

- [ ] **Step 2: Run focused Stars tests**

Run:

```sh
node --test \
  tests/telegram-bot-api.test.mjs \
  tests/stars-support-worker.test.mjs \
  tests/stars-support.test.mjs \
  tests/platform.test.mjs \
  tests/telegram-platform.test.mjs \
  tests/app-behavior.test.mjs \
  tests/privacy.test.mjs \
  tests/telegram-build.test.mjs \
  tests/telegram-stars-webhook-script.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run:

```sh
npm test
```

Expected: PASS. If Chrome cannot launch in the filesystem sandbox, rerun only
`tests/telegram-layout-browser.test.mjs` with the required browser permission;
do not treat a sandbox `SIGABRT` as an application failure.

- [ ] **Step 4: Run all coverage gates**

Run:

```sh
npm run coverage
```

Expected: all configured gates pass, including 98% core and critical Worker
line coverage. Do not lower any threshold.

- [ ] **Step 5: Verify shared web, Telegram, and native builds**

Run:

```sh
npm run build
npm run mobile:verify
```

Expected: PASS; `dist/support.html` exists; `dist/telegram/index.html` uses the
same hashed application bundle as `dist/index.html`; Capacitor sync succeeds.

- [ ] **Step 6: Review the diff for secret and privacy leaks**

Run:

```sh
git diff --check
git status --short
git diff --stat origin/main...HEAD
rg -n "TELEGRAM_BOT_TOKEN=|TELEGRAM_WEBHOOK_SECRET=" . \
  --glob '!node_modules/**' --glob '!.git/**'
```

Expected: no secret values, tokens, payloads, charge IDs, generated build output,
or unrelated worktree changes are staged. Environment variable names in docs
are acceptable; literal secret values are not.

- [ ] **Step 7: Request code review**

Use `superpowers:requesting-code-review` against the complete branch. Resolve
all correctness, security, and missing-test findings, then rerun focused and
full verification.

- [ ] **Step 8: Commit final verification fixes**

If verification required changes:

```sh
git add <only the files changed for verification>
git commit -m "test: harden Telegram Stars support"
```

Do not deploy or spend Stars in automated verification. Remote migration,
Worker deployment, webhook registration, Pages deployment, and the real 8-Star
smoke test remain explicit operator-controlled release steps.

## Plan Self-Review

- The implementation uses one shared UI and game bundle for web, Telegram,
  Android, and iOS; only the platform capability changes visibility.
- The client can request an amount but cannot supply identity, currency, label,
  title, description, payload, or payment status.
- `successful_payment` is the only authoritative paid transition.
- Pre-checkout revalidates owner, amount, currency, payload, state, and expiry.
- D1 constraints plus conditional updates make webhook redelivery idempotent.
- Bot API and webhook errors are bounded and redacted.
- The webhook has a dedicated secret and no permissive browser CORS.
- Payment data never joins gameplay, profile, leaderboard, matchmaking,
  achievement, training, or replay state.
- Web, Android, and iOS do not render payment controls or open payment URLs.
- Terms, support, privacy, localization, deployment, refund support, tests, and
  coverage are included with no placeholders or unresolved design choices.
