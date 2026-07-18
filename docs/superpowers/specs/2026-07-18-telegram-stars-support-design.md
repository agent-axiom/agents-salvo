# Telegram Stars Support Design

**Date:** 2026-07-18
**Status:** Approved for implementation planning

## Goal

Add optional support payments through Telegram Stars to the Salvo Telegram Mini
App. The game remains free and complete. A payment must not unlock gameplay,
change rating, add a public badge, alter matchmaking, or affect any other game
state.

The feature is visible only inside the Telegram Mini App. The website and the
Android and iOS applications continue to use the same shared source tree, but do
not show the support controls.

## Product Scope

The settings panel contains one compact `Support Salvo` section. Opening it
shows a modal with these amounts:

- 8 Telegram Stars;
- 88 Telegram Stars;
- 360 Telegram Stars;
- a custom whole-Star amount from 1 through 10,000 inclusive.

The modal states explicitly that support is voluntary and provides no gameplay
benefits. A user must explicitly accept the support terms before the payment
button becomes available. A confirmation step repeats the exact amount before
the native Telegram invoice opens.

The feature does not add supporter totals, supporter identity, badges, rewards,
public recognition, analytics, advertising, or recurring payments.

## Selected Approach

The Mini App opens a native Telegram invoice while the Worker owns invoice
creation and payment verification. This keeps the user inside the game and
preserves the Telegram receipt, webhook, dispute, and refund flow.

Rejected alternatives:

- Sending an invoice in the bot chat interrupts the game and requires manual
  navigation back to the Mini App.
- An external payment or donation URL is not an acceptable substitute for
  Telegram Stars inside Telegram and cannot provide the same authoritative
  payment confirmation.
- Telegram's legacy HTML5 Games platform is unrelated to Mini App payments and
  is not introduced by this feature.

## Shared Application Architecture

The existing shared application remains the only gameplay source. Payment
support is isolated behind the platform contract:

- Telegram reports native invoice support and implements `openInvoice` with
  `Telegram.WebApp.openInvoice`.
- Web and Capacitor platforms report invoice support as unavailable and never
  attempt to open an invoice.
- Shared UI renders the support section only when the selected runtime is the
  Telegram platform and the invoice capability is available.
- Payment code never imports or mutates game rules, boards, match records,
  ratings, achievements, training state, or replay state.

A focused client module owns Worker requests, response validation, cancellation,
timeouts, and bounded status polling. The main application owns only modal state
and rendering.

## User Experience

### Entry

The settings panel shows `Support Salvo` below account controls and above build
metadata. The row uses a star icon and a single command button. It is absent,
not disabled, on web, Android, and iOS.

### Amount Selection

The support modal contains three preset amount buttons and a `Custom amount`
numeric input. The input accepts ASCII decimal digits only, has a step of one,
and validates the inclusive range 1-10,000. Localized error text appears next to
the input without changing layout.

The terms checkbox links to the public support terms. The exact amount is shown
again on the final confirmation button. A user can return to amount selection
without losing a valid custom value.

### Payment States

Only one invoice flow may run at a time. While the Worker creates an invoice,
amount controls and the confirmation button are disabled.

The Telegram invoice callback is normalized to these states:

- `paid`: poll the authoritative Worker status for a bounded period, then show
  the localized thank-you state after `successful_payment` is stored;
- `pending`: show that Telegram is processing the payment and offer a status
  retry;
- `cancelled`: return quietly to the amount selector;
- `failed`: retain the amount and show a retryable, localized error;
- unsupported or malformed provider output: fail closed as unavailable.

If Telegram reports `paid` but the webhook has not reached the Worker within the
bounded polling window, the UI says that Telegram accepted the payment and that
server confirmation is pending. It must not falsely report a confirmed receipt.

The modal is keyboard accessible, traps focus while open, restores focus to the
entry button, exposes errors and status changes through an ARIA live region, and
respects Telegram safe-area insets.

## HTTP API

### Create Invoice

`POST /payments/stars/invoices`

Requirements:

- a valid Salvo bearer session;
- JSON content type and a bounded request body;
- body `{ "amount": integer, "locale": "en" | "ru" | "zh" }`;
- amount in the inclusive range 1-10,000.

The Worker derives the Telegram user identifier from the authenticated user. It
does not trust a user identifier, title, description, label, currency, or price
text supplied by the client.

The response is bounded JSON:

```json
{
  "invoiceId": "opaque identifier",
  "invoiceUrl": "https://t.me/$...",
  "amount": 88,
  "currency": "XTR",
  "expiresAt": "ISO-8601 timestamp"
}
```

The Worker creates one D1 record before calling Telegram
`createInvoiceLink`. The Bot API request uses:

- server-owned localized title and description;
- an opaque payload between 1 and 128 bytes;
- currency `XTR`;
- exactly one `LabeledPrice` with the validated amount;
- no `provider_token`, recurring subscription, shipping, contact, or external
  provider fields.

If invoice creation fails, the record becomes `failed`. The response and logs
must not expose the bot token, invoice payload, Telegram response body, user key,
or webhook secret.

### Read Invoice Status

`GET /payments/stars/invoices/:invoiceId`

The route requires the same authenticated owner. It returns only the public
invoice identifier, amount, currency, status, and relevant timestamps. It never
returns the invoice payload or Telegram charge identifier.

Public statuses are `pending`, `paid`, `expired`, and `failed`. Internal refund
state is not exposed as a supporter reward or profile attribute.

### Telegram Webhook

`POST /telegram/webhook`

The route is not a browser API and does not receive permissive CORS headers. It
requires an exact `X-Telegram-Bot-Api-Secret-Token` match against the dedicated
`TELEGRAM_WEBHOOK_SECRET` Worker secret. Missing configuration fails closed.
Request size and JSON structure are bounded before processing.

The webhook handles only:

- `pre_checkout_query`;
- `message.successful_payment`;
- `/terms`, `/support`, and `/paysupport` messages.

Other valid Telegram updates receive a generic success response without side
effects. Secrets and payment records are never included in webhook responses.

## Pre-Checkout Validation

A pre-checkout query is approved only when all of these conditions hold:

1. currency is exactly `XTR`;
2. total amount equals the stored amount;
3. the opaque invoice payload identifies an existing pending invoice;
4. the payer Telegram identifier equals the authenticated owner stored with the
   invoice;
5. the invoice is no more than 15 minutes old and has not expired, failed, paid,
   or been refunded.

The Worker calls `answerPreCheckoutQuery` within Telegram's ten-second deadline.
A validation failure receives `ok: false` with a short localized error suitable
for display by Telegram. Bot API timeouts are shorter than the pre-checkout
deadline and all provider errors are redacted.

## Successful Payment Handling

`successful_payment` is the only authoritative payment confirmation. The Worker
checks the stored payload, payer, currency, and amount again before updating D1.

The update stores:

- paid status and timestamp;
- `telegram_payment_charge_id` for support and refunds;
- the Telegram user identifier needed by `refundStarPayment`.

The charge identifier is unique. Repeated delivery of the same Telegram update
is idempotent. A conflicting charge, amount, user, currency, or payload fails
closed and is not rewritten. Transient D1 failures return a retryable webhook
response so Telegram can redeliver the update.

No game content is delivered after payment; the only client-side effect is a
thank-you message.

## Data Model

Migration `0004_star_support_payments.sql` creates a dedicated table with:

- opaque invoice ID as the primary key;
- unique opaque invoice payload;
- private Salvo user key;
- Telegram payer identifier;
- integer amount with a 1-10,000 check;
- fixed `XTR` currency check;
- constrained lifecycle status;
- creation, expiry, payment, failure, and optional refund timestamps;
- unique nullable Telegram charge identifier.

Indexes support owner status reads and expiry cleanup. Payment rows are not
joined into public profiles or leaderboard queries. The charge identifier and
private user key never leave authenticated server workflows.

## Terms, Privacy, and Support

A public localized support-terms page explains:

- support is voluntary and does not purchase gameplay access or advantages;
- the selected Stars amount is charged once;
- Telegram processes the Stars transaction;
- how to request payment support or a legitimate refund;
- Telegram Support and the bot platform do not resolve merchant disputes;
- the project's support contact.

The privacy notice is updated in English, Russian, and Chinese to disclose the
minimum payment records stored for verification, receipts, disputes, and
refunds.

The bot webhook answers:

- `/terms` with the public terms URL;
- `/support` and `/paysupport` with the GitHub Issues support URL, safe reporting
  instructions, and the clarification that Telegram Support cannot resolve the
  purchase.

Users are told not to publish session tokens, invoice payloads, or payment charge
identifiers in public issues.

## Security Properties

- Every invoice is server-created and bound to an authenticated Telegram user.
- Client-provided amounts are integers and are validated again at every payment
  stage.
- Invoice payloads are opaque, unguessable, bounded, single-purpose values.
- Webhook authentication uses a dedicated high-entropy secret and constant-time
  comparison.
- Bot API calls use strict HTTPS endpoints, explicit methods, bounded deadlines,
  bounded response bodies, and validated JSON shapes.
- Browser responses and logs remain redacted.
- D1 uniqueness and conditional updates provide idempotency.
- Expired invoices cannot pass pre-checkout.
- Payment processing does not share ownership with game or room state.
- The production webhook registers only the update types needed by this design.

## Failure and Recovery

- Offline or unauthenticated users cannot create an invoice.
- Missing Worker secrets or D1 bindings make support unavailable without
  blocking local or online gameplay.
- Bot API invoice failures are retryable from the retained amount selector.
- Closing or cancelling the native invoice never marks a payment as successful.
- Delayed webhook confirmation remains pending and can be checked again.
- Duplicate webhooks do not duplicate payment rows.
- A stored Telegram charge ID permits a manual `refundStarPayment` operation
  after the user's identity and request are verified.
- Disabling the UI or payment endpoint does not affect existing receipts or the
  rest of the game.

## Testing

Implementation follows red-green-refactor and adds focused tests for:

- platform capability parity and every Telegram invoice callback state;
- UI visibility only in Telegram, amount presets, custom range validation,
  terms acceptance, confirmation, cancellation, retry, focus, and ARIA status;
- strict client request and response contracts, cancellation, timeouts, and
  bounded polling;
- exact routing and methods for invoice, status, and webhook endpoints;
- authorization and owner-only status reads;
- fixed and custom amount validation, localization, and Bot API request shape;
- missing configuration, network failures, oversized bodies, malformed JSON,
  and redacted provider errors;
- webhook-secret validation and exact update parsing;
- valid, expired, replayed, wrong-user, wrong-amount, wrong-currency, unknown,
  and already-paid pre-checkout queries;
- successful payment idempotency and conflicting charge rejection;
- D1 migration constraints and privacy of public API responses;
- `/terms`, `/support`, and `/paysupport` responses;
- English, Russian, and Chinese translation parity;
- privacy, terms, build publication, Telegram shell, web, Android, and iOS
  regression behavior.

The existing full suite and all critical coverage gates remain enabled. Headless
layout verification runs with the permissions required to launch Chrome.

## Deployment

Production enablement follows this order:

1. merge and publish the static terms/privacy pages without exposing support UI;
2. apply the D1 migration remotely;
3. add a high-entropy `TELEGRAM_WEBHOOK_SECRET` with Wrangler;
4. deploy the Worker;
5. register `https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook`
   through Telegram `setWebhook`, using the same secret and only `message` and
   `pre_checkout_query` updates;
6. confirm `getWebhookInfo` reports the exact URL and no delivery error;
7. publish the shared Pages build that exposes the Telegram-only UI;
8. manually test cancellation and a real 8-Star payment in the production Mini
   App, then confirm the D1 receipt and support flow;
9. verify the website and Android/iOS builds do not show payment controls.

The manual real payment requires explicit operator action. Automated tests use
fake Bot API and D1 providers and never spend Stars.

## Acceptance Criteria

- Only Telegram Mini App users see `Support Salvo`.
- The user can select 8, 88, 360, or a custom whole amount from 1 to 10,000
  Stars.
- The invoice opens in Telegram without leaving the Mini App.
- A thank-you confirmation is shown only after the Worker stores an authoritative
  `successful_payment`.
- Payment has no effect on gameplay, profiles, leaderboards, matchmaking,
  achievements, or visibility.
- Invalid or forged invoice and webhook data cannot create a paid receipt.
- Duplicate updates remain idempotent and charge IDs are retained for refunds.
- Terms, payment support, and privacy disclosures are available in English,
  Russian, and Chinese.
- The full test suite, coverage gates, web build, Telegram build, and native build
  checks pass before deployment.

## References

- [Telegram Bot Payments API for Digital Goods and Services](https://core.telegram.org/bots/payments-stars)
- [Telegram Bot API: createInvoiceLink](https://core.telegram.org/bots/api#createinvoicelink)
- [Telegram Bot API: answerPreCheckoutQuery](https://core.telegram.org/bots/api#answerprecheckoutquery)
- [Telegram Mini Apps: openInvoice](https://core.telegram.org/bots/webapps)
