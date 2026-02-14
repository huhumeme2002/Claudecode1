# Prompt: Build Token-Based API Billing Proxy

Use a team of agents to build this project. Create a team with these agents working in parallel:
- **architect**: Design database schema (Prisma), types, and project structure
- **backend-proxy**: Build the proxy core with multi-model routing and token tracking
- **backend-admin**: Build admin API endpoints (models, pricing, users, billing)
- **frontend**: Build admin dashboard UI

---

## Project Overview

Build a TypeScript API proxy server that sells AI API access charged by token usage ($ per million tokens). The server sits between clients and multiple AI backends (Claude, GPT, Gemini, MiniMax, etc.), routes requests to the correct upstream API, tracks input/output tokens from responses, and deducts cost from user balance in real-time.

**Tech stack**:
- Runtime: Node.js + TypeScript + Express
- Database: PostgreSQL + Prisma ORM
- Cache: LRU in-memory for hot data (model mappings, settings)
- Auth: JWT for admin, API key for users
- Deployment: VPS with PM2 (Express standalone only, no Vercel)
- Dependencies: express, @prisma/client, jsonwebtoken, lru-cache, winston, cors, dotenv

**Key difference from CursorAugment2**: Instead of daily request quotas, users have a **dollar balance**. Each request costs money based on actual input/output token counts × per-model pricing.

---

## Core Architecture

### Request Flow
```
Client (OpenAI-compatible) → Express server → Auth (API key) → Model Mapping → Upstream API → Parse token usage from response → Calculate cost → Deduct from balance → Stream/return response
```

### Multi-Model Mapping System

Admin configures N models. Each model has:
```typescript
interface ModelMapping {
  id: string;                    // UUID
  display_name: string;          // What client sends (e.g., "gpt-4o", "claude-sonnet", "gemini-pro")
  actual_model: string;          // What upstream API receives (e.g., "gpt-4o-2024-08-06")
  api_url: string;               // Upstream endpoint (e.g., "https://api.openai.com/v1")
  api_key: string;               // Upstream API key
  api_format: 'openai' | 'anthropic';  // Determines how to parse token usage from response
  pricing: {
    input_per_million: number;   // $ per 1M input tokens (e.g., 3.00)
    output_per_million: number;  // $ per 1M output tokens (e.g., 15.00)
  };
  is_active: boolean;
  description?: string;
  // System prompt injection
  system_prompt?: string;              // Custom system prompt to inject for this model
  disable_system_prompt_injection: boolean;  // If true, skip ALL prompt injection for this model
}
```

Client sends `"model": "claude-sonnet"` → proxy looks up ModelMapping by `display_name` → replaces with `actual_model` → forwards to `api_url`.

### Token Usage Parsing

After upstream responds, extract token counts:

**Anthropic format (stream)**:
- `message_start` event → `message.usage.input_tokens`
- `message_delta` event → `usage.output_tokens`

**Anthropic format (non-stream)**:
- `response.usage.input_tokens` / `response.usage.output_tokens`

**OpenAI format (stream)**:
- Final chunk with `usage.prompt_tokens` / `usage.completion_tokens`

**OpenAI format (non-stream)**:
- `response.usage.prompt_tokens` / `response.usage.completion_tokens`

### Cost Calculation

```
input_cost  = (input_tokens / 1_000_000) × pricing.input_per_million
output_cost = (output_tokens / 1_000_000) × pricing.output_per_million
total_cost  = input_cost + output_cost
```

Deduct `total_cost` from user balance AFTER successful response (not before). If balance < 0 after deduction, still allow this request but block next one.

---

## Database Schema (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model ApiKey {
  id                 String      @id @default(uuid())
  key                String      @unique          // The actual API key string (e.g., "sk-xxxx")
  name               String                       // Display name
  balance            Float       @default(0)      // Current $ balance
  total_spent        Float       @default(0)      // Lifetime spending
  total_input_tokens BigInt      @default(0)      // Lifetime input tokens
  total_output_tokens BigInt     @default(0)      // Lifetime output tokens
  is_active          Boolean     @default(true)
  expiry             DateTime?
  created_at         DateTime    @default(now())
  updated_at         DateTime    @updatedAt
  usage_logs         UsageLog[]

  @@map("api_keys")
}

model ModelMapping {
  id                              String      @id @default(uuid())
  display_name                    String      @unique  // What client sends (e.g., "claude-sonnet")
  actual_model                    String               // What upstream receives (e.g., "claude-sonnet-4-20250514")
  api_url                         String               // Upstream endpoint
  api_key                         String               // Upstream API key
  api_format                      String      @default("openai")  // "openai" | "anthropic"
  input_price_per_million         Float                // $/1M input tokens
  output_price_per_million        Float                // $/1M output tokens
  system_prompt                   String?              // Custom system prompt for this model
  disable_system_prompt_injection Boolean     @default(false)
  is_active                       Boolean     @default(true)
  description                     String?
  created_at                      DateTime    @default(now())
  updated_at                      DateTime    @updatedAt
  usage_logs                      UsageLog[]

  @@map("model_mappings")
}

model UsageLog {
  id              String       @id @default(uuid())
  api_key_id      String
  api_key         ApiKey       @relation(fields: [api_key_id], references: [id], onDelete: Cascade)
  model_mapping_id String
  model_mapping   ModelMapping @relation(fields: [model_mapping_id], references: [id], onDelete: Cascade)
  model_display   String                // Snapshot of display_name at request time
  input_tokens    Int
  output_tokens   Int
  input_cost      Float                 // $ charged for input
  output_cost     Float                 // $ charged for output
  total_cost      Float                 // input_cost + output_cost
  duration_ms     Int                   // Request duration
  created_at      DateTime     @default(now())

  @@index([api_key_id, created_at])
  @@index([model_mapping_id, created_at])
  @@index([created_at])
  @@map("usage_logs")
}

model Setting {
  key   String @id                     // e.g., "global_system_prompt", "default_balance"
  value String                         // JSON-encoded value

  @@map("settings")
}
```

### Settings keys stored in `settings` table:
- `default_balance` → default $ for new keys (number)
- `min_balance` → minimum balance to allow requests (number)
- `site_name` → site display name (string)
- `global_system_prompt` → injected into all requests unless disabled (string)
- `global_disable_system_prompt` → master switch (boolean)

### Core Types

Types are auto-generated by Prisma from the schema above. Use `import { ApiKey, ModelMapping, UsageLog, Setting } from '@prisma/client'`.

Additional helper types in `lib/types.ts`:

```typescript
interface UsageLogEntry {
  model_mapping_id: string;
  model_display: string;
  input_tokens: number;
  output_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  duration_ms: number;
}

interface DashboardStats {
  total_revenue: number;
  total_input_tokens: number;
  total_output_tokens: number;
  active_keys: number;
  per_model: Array<{
    model_display: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    revenue: number;
  }>;
}

interface EffectiveSettings {
  default_balance: number;
  min_balance: number;
  site_name: string;
  global_system_prompt: string | null;
  global_disable_system_prompt: boolean;
}
```

---

## API Endpoints

### Proxy (main)
- `POST /v1/chat/completions` → OpenAI-compatible proxy (routes to correct upstream based on model)
- `POST /v1/messages` → Anthropic-compatible proxy

### User endpoints (API key auth)
- `GET /api/user/status` → balance, usage stats, key info
- `GET /api/user/models` → list available models with pricing (no API keys exposed)
- `GET /api/user/usage?date=YYYY-MM-DD` → usage history for a day

### Admin endpoints (JWT auth)
- `POST /api/admin/login` → JWT login
- **Model mappings CRUD**:
  - `GET /api/admin/models/list`
  - `POST /api/admin/models/create` → create model mapping with pricing
  - `POST /api/admin/models/update` → update model/pricing
  - `POST /api/admin/models/delete`
- **User/Key management**:
  - `GET /api/admin/keys/list` → all keys with balances
  - `POST /api/admin/keys/create` → create key with initial balance
  - `POST /api/admin/keys/delete`
  - `POST /api/admin/keys/add-balance` → add $ to a key
  - `POST /api/admin/keys/set-balance` → set exact balance
- **Dashboard**:
  - `GET /api/admin/dashboard` → total revenue, total tokens, active users, per-model stats
- **Settings**:
  - `GET /api/admin/settings/get`
  - `POST /api/admin/settings/save`

### Dynamic routing
Same pattern as CursorAugment2: `server.ts` maps `/api/*` paths to `./api/**/*.ts` files dynamically. No need to register routes manually. Deploy on VPS with PM2 (cluster mode).

---

## Admin Dashboard (public/admin/)

Single-page HTML + vanilla JS (same approach as CursorAugment2, no React/Vue).

### Pages/Tabs:
1. **Dashboard**: Total revenue, total tokens used, active keys count, per-model revenue chart
2. **Models**: CRUD for model mappings. Each row shows: display_name, actual_model, api_url, input price, output price, active toggle. Expandable row or modal for: system_prompt textarea, disable_system_prompt_injection checkbox
3. **API Keys**: List all keys with columns: name, balance, total_spent, status, created. Actions: add balance, disable, delete
4. **Settings**: Site name, default balance for new keys, min balance threshold, global_system_prompt textarea, global_disable_system_prompt toggle

---

## Proxy Implementation Details

The proxy (`api/proxy.ts`) should:

1. **Auth**: Extract API key from `Authorization: Bearer {key}`, validate against database
2. **Balance check**: If `balance <= settings.min_balance`, return 402 Payment Required with balance info
3. **Model lookup**: Find ModelMapping by `requestBody.model` matching `display_name`. If not found, return 400 with available models list
4. **Transform**: Replace `model` field with `actual_model`, forward to `api_url`
5. **Headers**: Set appropriate headers based on `api_format` (OpenAI uses `Authorization: Bearer`, Anthropic uses `x-api-key` + `anthropic-version`)
6. **Stream handling**:
   - Parse SSE chunks to extract token usage (accumulate during stream)
   - Forward chunks to client unchanged (except model name replacement)
   - After stream ends, calculate cost and deduct from balance
   - SSE heartbeat every 15s to prevent timeout
7. **Non-stream handling**: Parse JSON response for usage, calculate cost, deduct, return response
8. **Logging**: Log every request with: key, model, input_tokens, output_tokens, cost, duration
9. **Error handling**: Upstream errors (4xx/5xx) should NOT deduct balance

---

## System Prompt Injection

The proxy supports injecting custom system prompts into requests before forwarding upstream. This is a 3-level system with granular control:

### Priority & Override Logic

```
1. Global master switch OFF (global_disable_system_prompt = true)
   → No injection at all, skip everything below

2. Per-model disable (ModelMapping.disable_system_prompt_injection = true)
   → Skip injection for THIS model only, even if global/model prompts exist

3. Per-model prompt exists (ModelMapping.system_prompt is set)
   → Use model-specific prompt (overrides global prompt)

4. Global prompt exists (GlobalSettings.global_system_prompt is set)
   → Use global prompt as fallback
```

In short: **Global switch → Per-model switch → Per-model prompt → Global prompt fallback**

### Injection Behavior

Depends on `api_format`:

**Anthropic format** (`api_format: 'anthropic'`):
- Set `requestBody.system = systemPrompt` (Anthropic uses top-level `system` field)

**OpenAI format** (`api_format: 'openai'`):
- If messages already contain a `role: "system"` message → replace its content
- If no system message exists → prepend `{ role: "system", content: systemPrompt }` to messages array

### Prompt Length Limit
- Max 10,000 characters per system prompt (both global and per-model)
- Truncate silently if exceeded

### Admin UI for System Prompts

In the **Models** tab:
- Each model mapping row has a "System Prompt" textarea field
- A toggle/checkbox: "Disable prompt injection for this model"
- Preview shows: effective prompt (model-specific or global fallback) with a label indicating source

In the **Settings** tab:
- "Global System Prompt" textarea
- "Disable all prompt injection" master toggle
- Note explaining the priority chain

### Admin Endpoints for Prompt Management

No separate endpoints needed — system prompts are part of existing CRUD:
- `POST /api/admin/models/create` and `/update` accept `system_prompt` and `disable_system_prompt_injection` fields
- `POST /api/admin/settings/save` accepts `global_system_prompt` and `global_disable_system_prompt` fields

### Proxy Implementation

In `api/proxy.ts`, after model lookup and before forwarding upstream:

```typescript
// Determine effective system prompt
let effectiveSystemPrompt: string | null = null;

if (!settings.global_disable_system_prompt && !modelMapping.disable_system_prompt_injection) {
    // Per-model prompt takes priority over global
    effectiveSystemPrompt = modelMapping.system_prompt || settings.global_system_prompt || null;

    if (effectiveSystemPrompt) {
        // Truncate if too long
        effectiveSystemPrompt = effectiveSystemPrompt.substring(0, 10000);

        if (modelMapping.api_format === 'anthropic') {
            requestBody.system = effectiveSystemPrompt;
        } else {
            // OpenAI format
            const hasSystem = requestBody.messages?.some((m: any) => m.role === 'system');
            if (hasSystem) {
                requestBody.messages = requestBody.messages.map((m: any) =>
                    m.role === 'system' ? { role: 'system', content: effectiveSystemPrompt } : m
                );
            } else {
                requestBody.messages.unshift({ role: 'system', content: effectiveSystemPrompt });
            }
        }
    }
}

console.log('[PROXY] System prompt injection:', {
    globalDisabled: settings.global_disable_system_prompt,
    modelDisabled: modelMapping.disable_system_prompt_injection,
    source: effectiveSystemPrompt ? (modelMapping.system_prompt ? 'model-specific' : 'global') : 'none',
    promptLength: effectiveSystemPrompt?.length || 0
});
```

---

## Environment Variables

```bash
DATABASE_URL=                 # PostgreSQL connection string (e.g., postgresql://user:pass@localhost:5432/api_billing)
ADMIN_PASSWORD=               # Admin login password
JWT_SECRET=                   # 32-char hex for JWT signing
PORT=3000                     # Express port (optional)
NODE_ENV=production           # Environment (optional)
```

No hardcoded API keys — all upstream API keys are stored in ModelMapping in the database.

---

## File Structure

```
project/
├── prisma/
│   └── schema.prisma               # Database schema (PostgreSQL)
├── api/
│   ├── proxy.ts                    # Main proxy with multi-model routing + token billing
│   ├── admin/
│   │   ├── login.ts
│   │   ├── dashboard.ts
│   │   ├── models/
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── update.ts
│   │   │   └── delete.ts
│   │   ├── keys/
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── delete.ts
│   │   │   ├── add-balance.ts
│   │   │   └── set-balance.ts
│   │   └── settings/
│   │       ├── get.ts
│   │       └── save.ts
│   └── user/
│       ├── status.ts
│       ├── models.ts
│       └── usage.ts
├── lib/
│   ├── db.ts                       # Prisma client singleton
│   ├── types.ts                    # Additional TypeScript interfaces
│   ├── auth.ts                     # JWT + API key verification
│   ├── billing.ts                  # Cost calculation, balance deduction, usage logging
│   ├── token-parser.ts             # Extract token counts from stream/non-stream responses
│   ├── cache.ts                    # LRU in-memory cache for model mappings + settings
│   ├── logger.ts                   # Winston logging with correlation IDs
│   └── utils.ts                    # UUID generation, helpers
├── public/
│   └── admin/
│       ├── index.html              # Admin SPA
│       └── app.js                  # Admin dashboard logic
├── server.ts                       # Express server with dynamic routing
├── ecosystem.config.js             # PM2 config (cluster mode)
├── package.json
├── tsconfig.json
└── .env
```

---

## Critical Rules

1. **Never deduct balance before upstream responds** — only after confirmed 2xx with token usage
2. **Always parse tokens from BOTH stream and non-stream** — use the token-parser module
3. **Balance can go negative on the last request** — check balance BEFORE request, deduct AFTER. This prevents race conditions
4. **All money values use number type** — stored as dollars with decimal (e.g., 10.50), not cents
5. **Model lookup is case-insensitive** — `"Claude-Sonnet"` and `"claude-sonnet"` should match
6. **Cache model mappings aggressively** — LRU in-memory cache with 60s TTL, clear on admin update. Use `lib/cache.ts` for all cached reads
7. **Log everything** — every proxy request should log: key (first 8 chars), model, tokens, cost, duration, source
8. **System prompt injection respects the 3-level chain** — global switch → per-model switch → per-model prompt → global fallback. Never inject if either switch is disabled
9. **Clear cache after admin updates** — when admin changes model mappings, settings, or system prompts, invalidate LRU cache so proxy picks up changes immediately
10. **Use Prisma transactions for billing** — deduct balance + insert usage log + update lifetime stats in a single transaction to prevent inconsistency
11. **Prisma client singleton** — use a single `PrismaClient` instance in `lib/db.ts`, never instantiate per-request
