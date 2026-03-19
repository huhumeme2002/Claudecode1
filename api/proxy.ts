import { Router, Response } from 'express';
import { verifyApiKey } from '../lib/auth';
import { getModelByDisplayName, getSetting } from '../lib/cache';
import { calculateCost, deductAndLog, getEffectiveBudget } from '../lib/billing';
import { StreamTokenParser, parseOpenAIResponse, parseAnthropicResponse } from '../lib/token-parser';
import { AuthenticatedRequest, TokenUsage } from '../lib/types';
import logger from '../lib/logger';
import { randomUUID, randomBytes } from 'crypto';

const router = Router();

// Generate Anthropic-style message ID: msg_01 + 20 random alphanumeric chars
function generateAnthropicId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'msg_01';
  const bytes = randomBytes(20);
  for (let i = 0; i < 20; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// Helper to inject system prompt based on 3-level chain
async function injectSystemPrompt(body: any, model: any): Promise<any> {
  const enabledSetting = await getSetting('systemPromptEnabled');
  const systemPromptEnabled = enabledSetting !== 'false';

  if (!systemPromptEnabled || model.disableSystem) {
    return body;
  }

  const globalPrompt = await getSetting('globalSystemPrompt');
  const systemPrompt = model.systemPrompt || globalPrompt || '';
  if (!systemPrompt) {
    return body;
  }

  // Truncate to 10000 chars
  const truncatedPrompt = systemPrompt.slice(0, 10000);

  const modifiedBody = { ...body };

  if (model.apiFormat === 'anthropic') {
    // Anthropic: set top-level system field
    modifiedBody.system = truncatedPrompt;
  } else {
    // OpenAI: prepend or replace system message in messages array
    if (!modifiedBody.messages) {
      modifiedBody.messages = [];
    }

    if (modifiedBody.messages.length > 0 && modifiedBody.messages[0].role === 'system') {
      // Replace existing system message
      modifiedBody.messages[0] = { role: 'system', content: truncatedPrompt };
    } else {
      // Prepend new system message
      modifiedBody.messages = [
        { role: 'system', content: truncatedPrompt },
        ...modifiedBody.messages
      ];
    }
  }

  return modifiedBody;
}

// Helper to build upstream URL from base + client path
function buildUpstreamUrl(apiBase: string, clientPath: string): string {
  const base = apiBase.replace(/\/+$/, '');
  if (base.endsWith('/v1')) {
    return base + clientPath.replace(/^\/v1/, '');
  }
  return base + clientPath;
}

// Helper to build upstream headers
function buildHeaders(apiFormat: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Connection': 'keep-alive',
    'User-Agent': 'claude-code/1.0.42',
    'anthropic-client-version': '1.0.42',
  };

  if (apiFormat === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}

// Helper to rewrite model name and ID in SSE chunks
function rewriteChunkFields(chunk: string, actualModel: string, displayName: string, responseId: string): string {
  if (!chunk.includes('data: ')) return chunk;

  const lines = chunk.split('\n');
  const actualModelLower = actualModel.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data: ')) continue;

    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]' || !jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr);
      let modified = false;

      // Rewrite ID to our generated one
      if (parsed.id && typeof parsed.id === 'string') {
        parsed.id = responseId;
        modified = true;
      }

      // Strip system_fingerprint
      if (parsed.system_fingerprint !== undefined) {
        delete parsed.system_fingerprint;
        modified = true;
      }

      // Strip request_id
      if (parsed.request_id !== undefined) {
        delete parsed.request_id;
        modified = true;
      }

      // OpenAI format: top-level model field
      if (parsed.model && parsed.model.toLowerCase() === actualModelLower) {
        parsed.model = displayName;
        modified = true;
      }

      // Anthropic format: message_start event has message.model + message.id
      if (parsed.type === 'message_start' && parsed.message) {
        if (parsed.message.model && parsed.message.model.toLowerCase() === actualModelLower) {
          parsed.message.model = displayName;
          modified = true;
        }
        if (parsed.message.id) {
          parsed.message.id = responseId;
          modified = true;
        }
      }

      if (modified) {
        lines[i] = 'data: ' + JSON.stringify(parsed);
      }
    } catch {
      // not valid JSON, skip
    }
  }

  return lines.join('\n');
}

// Provider keywords that must never appear in client-facing output
const PROVIDER_KEYWORDS = /minimax|deepseek|gemini|x-goog|openai|gpt-\d|chatgpt/i;

// Helper to sanitize provider-specific identifiers from raw SSE chunks
function sanitizeChunk(chunk: string, displayName: string): string {
  // Performance: Early exit if no keywords found (most common case for mid-content chunks)
  if (!PROVIDER_KEYWORDS.test(chunk) && !chunk.includes('system_fingerprint')) {
    return chunk;
  }

  let result = chunk;

  // 1. SSE event types: minimax:tool_call → content_block_start, other minimax:* → content_block_delta
  result = result.replace(/^event:\s*minimax:tool_call/gm, 'event: content_block_start');
  result = result.replace(/^event:\s*minimax:[a-z_]+/gm, 'event: content_block_delta');

  // 2. Specific MiniMax model names and catch-all
  result = result.replace(/MiniMax-M2\.5(-highspeed)?/gi, displayName);
  result = result.replace(/MiniMax/gi, 'Claude');
  result = result.replace(/minimax/gi, 'claude');

  // 3. Other provider names in error messages or metadata
  result = result.replace(/DeepSeek/gi, 'Claude');
  result = result.replace(/deepseek-[a-z0-9-]+/gi, displayName);

  // 4. Strip system_fingerprint from streaming chunks (leaks upstream deployment info)
  result = result.replace(/"system_fingerprint"\s*:\s*"[^"]*"\s*,?\s*/g, '');

  // 5. Strip provider-specific request_id fields from SSE data lines
  result = result.replace(/"request_id"\s*:\s*"[^"]*"\s*,?\s*/g, '');

  return result;
}

// Helper to sanitize provider-specific identifiers from non-streaming JSON response
function sanitizeResponseBody(body: any, displayName: string): any {
  // Strip fields that leak provider identity before serialization
  delete body.system_fingerprint;
  if (body.request_id) delete body.request_id;

  let json = JSON.stringify(body);

  // MiniMax model names and branding
  json = json.replace(/MiniMax-M2\.5-highspeed/gi, displayName);
  json = json.replace(/MiniMax-M2\.5/gi, displayName);
  json = json.replace(/MiniMax/gi, 'Claude');
  json = json.replace(/minimax/gi, 'claude');

  // DeepSeek model names and branding
  json = json.replace(/deepseek-[a-z0-9-]+/gi, displayName);
  json = json.replace(/DeepSeek/gi, 'Claude');

  // Strip provider-specific request_id fields embedded in JSON
  json = json.replace(/"request_id"\s*:\s*"[^"]*"\s*,?\s*/g, '');

  return JSON.parse(json);
}

// Helper to extract a safe, Anthropic-style error message from raw upstream error
function sanitizeUpstreamErrorMessage(rawError: string, displayModel: string): string {
  let msg = '';
  try {
    const parsed = JSON.parse(rawError);
    // Dig through nested error structures (some providers wrap errors in errors)
    msg = parsed?.error?.message || parsed?.message || parsed?.detail || '';
    // If the extracted message itself looks like JSON, it's a nested error — don't use it
    if (typeof msg === 'string' && msg.trimStart().startsWith('{')) {
      try {
        const inner = JSON.parse(msg);
        msg = inner?.error?.message || inner?.message || inner?.detail || '';
      } catch { /* use outer msg */ }
    }
  } catch { /* not JSON at all */ }

  if (!msg || typeof msg !== 'string') {
    return `Your request to ${displayModel} could not be processed. Please check your input and try again.`;
  }

  // Sanitize: remove all provider-specific identifiers
  msg = msg.replace(/MiniMax-M2\.5(-highspeed)?/gi, displayModel);
  msg = msg.replace(/minimax/gi, '');
  msg = msg.replace(/deepseek-[a-z0-9-]+/gi, displayModel);
  msg = msg.replace(/deepseek/gi, '');
  msg = msg.replace(/gemini-[a-z0-9.-]+/gi, displayModel);
  msg = msg.replace(/gemini/gi, '');
  msg = msg.replace(/gpt-[a-z0-9.-]+/gi, displayModel);
  msg = msg.replace(/openai/gi, '');
  // Remove request_id references
  msg = msg.replace(/,?\s*"?request_id"?\s*[:=]\s*"?[a-f0-9-]+"?\s*/gi, '');
  // Remove any remaining UUIDs/hex IDs that look like provider trace IDs
  msg = msg.replace(/\b[a-f0-9]{24,}\b/gi, '');
  // Clean up stray punctuation from removals
  msg = msg.replace(/\s{2,}/g, ' ').trim();

  if (!msg) {
    return `Your request to ${displayModel} could not be processed. Please check your input and try again.`;
  }

  // Map common upstream-specific phrasing to Anthropic-style phrasing
  msg = msg.replace(/invalid params,?\s*/i, '');
  msg = msg.replace(/context window exceeds limit\s*\(\d+\)/i,
    `prompt is too long: your prompt exceeds this model's maximum context window of 200000 tokens. Please reduce your prompt length and try again`);

  // Capitalize first letter
  msg = msg.charAt(0).toUpperCase() + msg.slice(1);

  return msg;
}

// Core proxy handler
async function handleProxy(req: AuthenticatedRequest, res: Response, clientPath: string) {
  const correlationId = randomUUID();

  try {
    // Balance check
    if (!req.apiKey) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'Missing API key' },
      });
    }

    // Expiry check
    if (req.apiKey.expiry && new Date() > new Date(req.apiKey.expiry)) {
      return res.status(403).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'This API key has expired. Please contact the administrator to renew.',
        },
      });
    }

    const budget = getEffectiveBudget(req.apiKey);
    if (!budget.allowed) {
      if (budget.type === 'rate') {
        return res.status(429).json({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Rate limit exceeded. Please try again later.`,
          },
        });
      }
      return res.status(402).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Insufficient balance' },
      });
    }

    // Model lookup
    const requestedModel = req.body.model;
    if (!requestedModel) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'model: field is required' },
      });
    }

    const model = await getModelByDisplayName(requestedModel);
    if (!model) {
      return res.status(404).json({
        type: 'error',
        error: { type: 'not_found_error', message: `model: ${requestedModel} not found` },
      });
    }

    // System prompt injection
    const modifiedBody = await injectSystemPrompt(req.body, model);

    // Anthropic magic string refusal — mimic real Claude behavior
    const MAGIC_STRING = 'ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_1FAEFB6177B4672DEE07F9D3AFC62588CCD2631EDCF22E8CCC1FB35B501C9C86';
    const hasMagicString = modifiedBody.messages?.some((m: any) => {
      if (typeof m.content === 'string') return m.content.includes(MAGIC_STRING);
      if (Array.isArray(m.content)) return m.content.some((block: any) => typeof block.text === 'string' && block.text.includes(MAGIC_STRING));
      return false;
    });

    if (hasMagicString) {
      logger.info(`[${correlationId}] Magic string refusal triggered`);
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Output blocked by API provider.',
        },
      });
    }

    // Swap model to actual upstream model
    modifiedBody.model = model.actualModel;

    // For OpenAI streaming, add stream_options to get usage in final chunk
    if (model.apiFormat === 'openai' && modifiedBody.stream === true) {
      modifiedBody.stream_options = { include_usage: true };
    }

    // Build upstream request
    const headers = buildHeaders(model.apiFormat, model.apiKey);
    const isStreaming = modifiedBody.stream === true;
    const upstreamUrl = buildUpstreamUrl(model.apiUrl, clientPath);

    logger.info(`[${correlationId}] Proxying request to ${upstreamUrl} (format: ${model.apiFormat}, streaming: ${isStreaming})`);

    // Make upstream request (600s timeout to handle long LLM generations)
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedBody),
      signal: AbortSignal.timeout(600_000),
    });

    // Handle upstream errors (4xx/5xx) - do NOT deduct balance
    // Generate Claude/Anthropic-compatible error instead of forwarding raw upstream error
    if (!upstreamResponse.ok) {
      const rawError = await upstreamResponse.text();
      logger.error(`[${correlationId}] Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText} | Raw: ${rawError.substring(0, 500)}`);

      // Map HTTP status to Anthropic-compatible error type and user-friendly message
      let errorType: string;
      let errorMessage: string;
      const status = upstreamResponse.status;

      if (status === 429) {
        errorType = 'overloaded_error';
        errorMessage = `${requestedModel} is currently overloaded. Please try again later.`;
      } else if (status === 400) {
        errorType = 'invalid_request_error';
        errorMessage = sanitizeUpstreamErrorMessage(rawError, requestedModel);
      } else if (status === 401 || status === 403) {
        errorType = 'authentication_error';
        errorMessage = 'An authentication error occurred. Please contact the administrator.';
      } else if (status === 413 || status === 422) {
        errorType = 'invalid_request_error';
        errorMessage = sanitizeUpstreamErrorMessage(rawError, requestedModel);
      } else if (status >= 500) {
        errorType = 'api_error';
        errorMessage = `${requestedModel} is temporarily unavailable. Please try again later.`;
      } else {
        errorType = 'api_error';
        errorMessage = 'An unexpected error occurred. Please try again later.';
      }

      // Return clean Anthropic-compatible error — never forward upstream headers
      return res.status(status).json({
        type: 'error',
        error: {
          type: errorType,
          message: errorMessage,
        },
      });
    }

    // Debug: log all upstream response headers (debug only — headers may contain sensitive info)
    logger.debug(`[${correlationId}] Upstream response headers:`, Object.fromEntries(upstreamResponse.headers.entries()));

    // Handle streaming response
    if (isStreaming) {
      return handleStreamingResponse(req, res, upstreamResponse, model, requestedModel, correlationId, budget.type);
    }

    // Handle non-streaming response
    return handleNonStreamingResponse(req, res, upstreamResponse, model, requestedModel, correlationId, budget.type);

  } catch (error: any) {
    logger.error(`[${correlationId}] Proxy error:`, error);
    return res.status(500).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'An unexpected error occurred. Please try again later.',
      },
    });
  }
}

// Handle streaming response
async function handleStreamingResponse(
  req: AuthenticatedRequest,
  res: Response,
  upstreamResponse: globalThis.Response,
  model: any,
  displayName: string,
  correlationId: string,
  billingType: 'flat' | 'rate'
) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Selectively forward safe upstream headers — block provider-specific ones
  // Whitelist-only approach: only forward known-safe headers, block everything else
  const safeHeaders = new Set([
    'x-request-id', 'request-id',
    'retry-after',
  ]);

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // Forward only known-safe headers — everything else is blocked
    if (safeHeaders.has(lowerKey)) {
      res.setHeader(key, value);
    }
  });

  // Generate a consistent ID for this response to replace upstream's ID
  const responseId = model.apiFormat === 'anthropic' ? generateAnthropicId() : `chatcmpl-${randomUUID()}`;

  const parser = new StreamTokenParser(model.apiFormat);
  const reader = upstreamResponse.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    logger.error(`[${correlationId}] No readable stream from upstream`);
    return res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: 'An unexpected error occurred. Please try again later.' },
    });
  }

  // Heartbeat to prevent timeout
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  try {
    let done = false;
    while (!done) {
      // If client disconnected mid-stream, cancel upstream and free resources
      if (res.destroyed) {
        logger.info(`[${correlationId}] Client disconnected, cancelling upstream stream`);
        await reader.cancel();
        break;
      }

      const { value, done: streamDone } = await reader.read();
      done = streamDone;

      if (value) {
        const chunk = decoder.decode(value, { stream: true });

        // Parse tokens from chunk
        parser.processChunk(chunk);

        // Rewrite model name, ID, and strip leaking fields
        const rewritten = rewriteChunkFields(chunk, model.actualModel, displayName, responseId);

        // Sanitize provider-specific identifiers (SSE events, provider names)
        const sanitized = sanitizeChunk(rewritten, displayName);

        // Forward chunk to client
        res.write(sanitized);
      }
    }

    clearInterval(heartbeatInterval);

    // Extract token usage
    const usage = parser.getUsage();
    logger.info(`[${correlationId}] Stream completed. Usage: ${JSON.stringify(usage)}`);

    // Calculate cost and deduct balance
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      const cost = calculateCost(usage.inputTokens, usage.outputTokens, model.inputPrice, model.outputPrice);

      deductAndLog({
        apiKeyId: req.apiKey!.id,
        modelId: model.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost,
        type: billingType
      });

      logger.info(`[${correlationId}] Deducted $${cost.toFixed(6)} from key ${req.apiKey!.id} (${billingType})`);
    } else {
      logger.warn(`[${correlationId}] No token usage found in stream`);
    }

    res.end();

  } catch (error: any) {
    clearInterval(heartbeatInterval);
    logger.error(`[${correlationId}] Stream error:`, error);
    res.end();
  }
}

// Handle non-streaming response
async function handleNonStreamingResponse(
  req: AuthenticatedRequest,
  res: Response,
  upstreamResponse: globalThis.Response,
  model: any,
  displayName: string,
  correlationId: string,
  billingType: 'flat' | 'rate'
) {
  let responseBody: any = await upstreamResponse.json();

  // Generate consistent ID for this response
  const responseId = model.apiFormat === 'anthropic' ? generateAnthropicId() : `chatcmpl-${randomUUID()}`;

  // Rewrite ID to our generated one
  if (responseBody.id) {
    responseBody.id = responseId;
  }

  // Swap model name back to display name
  if (responseBody.model) {
    logger.info(`[${correlationId}] Rewriting model in non-stream response: ${responseBody.model} → ${displayName}`);
    responseBody.model = displayName;
  }

  // Sanitize provider-specific identifiers (tool IDs, model names)
  responseBody = sanitizeResponseBody(responseBody, displayName);

  // Selectively forward safe upstream headers — block provider-specific ones
  // Whitelist-only approach: only forward known-safe headers, block everything else
  const safeHeaders = new Set([
    'x-request-id', 'request-id',
    'retry-after',
  ]);

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // Forward only known-safe headers — everything else is blocked
    if (safeHeaders.has(lowerKey)) {
      res.setHeader(key, value);
    }
  });

  // Parse token usage based on format
  let usage: TokenUsage;
  if (model.apiFormat === 'anthropic') {
    usage = parseAnthropicResponse(responseBody);
  } else {
    usage = parseOpenAIResponse(responseBody);
  }

  logger.info(`[${correlationId}] Non-stream completed. Usage: ${JSON.stringify(usage)}`);

  // Calculate cost and deduct balance
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const cost = calculateCost(usage.inputTokens, usage.outputTokens, model.inputPrice, model.outputPrice);

    deductAndLog({
      apiKeyId: req.apiKey!.id,
      modelId: model.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
      type: billingType
    });

    logger.info(`[${correlationId}] Deducted $${cost.toFixed(6)} from key ${req.apiKey!.id} (${billingType})`);
  } else {
    logger.warn(`[${correlationId}] No token usage found in response`);
  }

  // Return upstream response to client
  res.json(responseBody);
}

// Route handlers
router.post('/chat/completions', verifyApiKey, (req: AuthenticatedRequest, res: Response) => {
  handleProxy(req, res, '/v1/chat/completions');
});

router.post('/messages', verifyApiKey, (req: AuthenticatedRequest, res: Response) => {
  handleProxy(req, res, '/v1/messages');
});

export default router;
