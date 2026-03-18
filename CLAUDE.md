# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Token-based API billing proxy server. Sits between clients and AI API providers (Claude, GPT, Gemini, MiniMax, etc.), routes requests to the correct upstream, tracks token usage, and deducts cost from user balance in real-time. Users have dollar balances instead of request quotas.

## Tech Stack

- Runtime: Node.js + TypeScript + Express
- Database: PostgreSQL + Prisma ORM
- Cache: LRU in-memory (60s TTL) for model mappings and settings
- Auth: JWT for admin, API key for proxy/user endpoints
- Deployment: VPS with PM2 cluster mode
- Frontend: Vanilla HTML + JS SPA (no React/Vue)

## Build & Run Commands

```bash
npm install                    # Install dependencies
npx prisma generate            # Generate Prisma client from schema
npx prisma migrate dev         # Run database migrations (dev)
npx prisma migrate deploy      # Run database migrations (prod)
npm run build                  # Compile TS + copy public/ to dist/
npm start                      # Start proxy server only (port 3000)
npm run dev                    # Dev mode via ts-node (run manually in terminal)
pm2 start ecosystem.config.js  # Start both servers in production
```

TypeScript compiles to `dist/` (CommonJS, ES2020 target). The build script also copies `public/` into `dist/public/` for static serving.

## Database

Prisma schema is located at `prisma/schema.prisma`. Tables use snake_case (`@@map`), TypeScript uses camelCase. `BigInt` is used for `totalTokens` on ApiKey — convert with `Number()` before JSON serialization.

Four models: `ApiKey`, `ModelMapping`, `UsageLog`, `Setting`.

## Environment Variables

Required in `.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `ADMIN_PASSWORD` — Admin login password
- `JWT_SECRET` — 32-char hex for JWT signing
- `PORT` — Express port (default 3000)
- `NODE_ENV` — production/development

## Architecture

### Request Flow

```
Client → Express → Auth (API key) → Expiry + Budget check → Model Mapping lookup →
System prompt injection → Swap model name → Upstream API → Parse token usage →
Calculate cost → Deduct balance (Prisma transaction) → Return response
```

### Two Billing Modes

API keys support two mutually exclusive billing modes:
- **Flat**: Key has a dollar `balance` that decreases with each request. Allowed when `balance > 0`.
- **Rate**: Key has `rateLimitAmount` ($/window) + `rateLimitIntervalHours`. Spending is tracked per rolling window via `rateLimitWindowStart` / `rateLimitWindowSpent`. Window resets automatically when expired. Flat balance is ignored for rate-plan keys.

`getEffectiveBudget()` in `lib/billing.ts` determines which mode applies and whether the request is allowed.

### Dynamic Routing

`server.ts` maps `/api/*` paths to `./api/**/*.ts` files dynamically — no manual route registration. Each API file exports a default Express Router. The proxy endpoints (`/v1/chat/completions`, `/v1/messages`) are registered explicitly and skip the dynamic loader.

Route path is derived from file path: `api/admin/keys/create.ts` → `/api/admin/keys/create`.

### Dual-Server Architecture

PM2 runs two processes (`ecosystem.config.js`):
- **`server.ts`** (port `PORT`, 5 cluster instances) — proxy + all API routes
- **`server-admin.ts`** (port `ADMIN_PORT=3001`, 1 instance) — admin/user API routes only, no proxy. Keeps dashboard/admin traffic from competing with 1264+ proxy connections.

Both servers use the same dynamic route loader (skipping `proxy.js`). Add `ADMIN_PORT` to `.env` if running locally with the admin server.

### Key Modules

- `api/proxy.ts` — Core proxy with multi-provider routing, streaming SSE forwarding, and token extraction
- `lib/token-parser.ts` — Extracts token counts from both OpenAI and Anthropic response formats (stream and non-stream). `StreamTokenParser` buffers SSE chunks and parses on `\n\n` boundaries.
- `lib/billing.ts` — Cost calculation (`$/million tokens`), budget checking, balance deduction, and usage logging in a single Prisma transaction
- `lib/cache.ts` — LRU cache for model mappings and settings; call `clearModelCache()` / `clearSettingsCache()` / `clearAllCaches()` on any admin update
- `lib/auth.ts` — `verifyAdmin` middleware (JWT) and `verifyApiKey` middleware (API key lookup). Both read `Authorization: Bearer <token>` header.
- `lib/logger.ts` — Winston logger singleton. Level: `debug` in dev, `info` in prod. Import as `import logger from './lib/logger'`. Also exports `correlationId()`.
- `lib/db.ts` — Prisma client singleton (never instantiate per-request)
- `lib/types.ts` — Shared TypeScript interfaces (`AuthenticatedRequest`, `TokenUsage`, `UsageLogEntry`, etc.)
- `lib/utils.ts` — `generateApiKey()` (sk-prefixed hex) and `generateId()` (UUIDv4)

### Frontend SPAs

- `/admin` → `public/admin/index.html` (admin panel, JWT auth)
- `/dashboard` → `public/dashboard/index.html` (user dashboard, API key auth)

Both are vanilla HTML+JS, no build step. Static files served from `public/`.

### Model Mapping System

Admin configures models with: display_name (client-facing) → actual_model (upstream) + api_url + api_key + api_format (`openai` | `anthropic`) + per-model pricing ($/million tokens). Lookup is case-insensitive. The proxy swaps `body.model` to `actualModel` before forwarding upstream.

For OpenAI streaming, the proxy injects `stream_options: { include_usage: true }` to get token counts in the final chunk.

### System Prompt Injection (3-level chain)

Priority: global master switch → per-model disable flag → per-model prompt → global prompt fallback. Anthropic format uses top-level `system` field; OpenAI format prepends/replaces system message in messages array. Max 10,000 chars, truncated silently.

### Token Parsing by Format

- **OpenAI**: `usage.prompt_tokens` / `usage.completion_tokens` (stream: final chunk; non-stream: response body)
- **Anthropic**: `message.usage.input_tokens` (message_start event) / `usage.output_tokens` (message_delta event)

## Critical Rules

1. Never deduct balance before upstream responds — only after confirmed 2xx with token usage
2. Balance can go negative on the last request — check before, deduct after
3. All money values are dollars with decimals (e.g., 10.50), not cents. Cost precision: 8 decimal places (`Math.round(x * 1e8) / 1e8`)
4. Use Prisma transactions for billing — deduct balance + insert usage log + update lifetime stats atomically
5. Cache model mappings aggressively (60s TTL), clear cache on any admin update
6. Stream handling must include SSE heartbeat every 15s to prevent timeout
7. Upstream errors (4xx/5xx) must NOT deduct balance
8. API keys have optional expiry — proxy checks `expiry` before budget check and returns 403 if expired
9. When adding new API routes, just create a file under `api/` — the dynamic loader picks it up automatically (export default Router)
