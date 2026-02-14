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
npx tsc                        # Compile TypeScript
npm start                      # Start server (or: pm2 start ecosystem.config.js)
```

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
Client → Express → Auth (API key) → Model Mapping lookup → Transform request →
Upstream API → Parse token usage → Calculate cost → Deduct balance (Prisma transaction) → Return response
```

### Dynamic Routing

`server.ts` maps `/api/*` paths to `./api/**/*.ts` files dynamically — no manual route registration. The proxy endpoints (`/v1/chat/completions`, `/v1/messages`) are registered explicitly.

### Key Modules

- `api/proxy.ts` — Core proxy with multi-provider routing, streaming SSE forwarding, and token extraction
- `lib/token-parser.ts` — Extracts token counts from both OpenAI and Anthropic response formats (stream and non-stream)
- `lib/billing.ts` — Cost calculation, balance deduction, and usage logging in a single Prisma transaction
- `lib/cache.ts` — LRU cache for model mappings and settings; must be invalidated on admin updates
- `lib/auth.ts` — JWT verification (admin) and API key validation (users)
- `lib/db.ts` — Prisma client singleton (never instantiate per-request)

### Model Mapping System

Admin configures models with: display_name (client-facing) → actual_model (upstream) + api_url + api_key + api_format (`openai` | `anthropic`) + per-model pricing ($/million tokens). Lookup is case-insensitive.

### System Prompt Injection (3-level chain)

Priority: global master switch → per-model disable flag → per-model prompt → global prompt fallback. Anthropic format uses top-level `system` field; OpenAI format prepends/replaces system message in messages array. Max 10,000 chars, truncated silently.

### Token Parsing by Format

- **OpenAI**: `usage.prompt_tokens` / `usage.completion_tokens` (stream: final chunk; non-stream: response body)
- **Anthropic**: `message.usage.input_tokens` (message_start event) / `usage.output_tokens` (message_delta event)

## Critical Rules

1. Never deduct balance before upstream responds — only after confirmed 2xx with token usage
2. Balance can go negative on the last request — check before, deduct after
3. All money values are dollars with decimals (e.g., 10.50), not cents
4. Use Prisma transactions for billing — deduct balance + insert usage log + update lifetime stats atomically
5. Cache model mappings aggressively (60s TTL), clear cache on any admin update
6. Stream handling must include SSE heartbeat every 15s to prevent timeout
7. Upstream errors (4xx/5xx) must NOT deduct balance
