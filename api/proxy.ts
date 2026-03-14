import { Router, Response } from 'express';
import { verifyApiKey } from '../lib/auth';
import { getModelByDisplayName, getSetting } from '../lib/cache';
import { calculateCost, deductAndLog, getEffectiveBudget } from '../lib/billing';
import { StreamTokenParser, parseOpenAIResponse, parseAnthropicResponse } from '../lib/token-parser';
import { AuthenticatedRequest, TokenUsage } from '../lib/types';
import logger from '../lib/logger';
import { randomUUID } from 'crypto';

const router = Router();

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

// Helper to replace model name in an SSE chunk (swap actual model back to display name)
function rewriteModelInChunk(chunk: string, actualModel: string, displayName: string): string {
  const actualModelLower = actualModel.toLowerCase();
  if (!chunk.toLowerCase().includes(actualModelLower)) return chunk;

  const lines = chunk.split('\n');
  let rewritten = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip event: lines, only process data: lines
    if (!line.startsWith('data: ')) continue;

    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]' || !jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr);

      // OpenAI format: top-level model field (case-insensitive)
      if (parsed.model && parsed.model.toLowerCase() === actualModelLower) {
        parsed.model = displayName;
        lines[i] = 'data: ' + JSON.stringify(parsed);
        rewritten = true;
      }

      // Anthropic format: message_start event has message.model (case-insensitive)
      if (parsed.type === 'message_start' && parsed.message?.model &&
        parsed.message.model.toLowerCase() === actualModelLower) {
        parsed.message.model = displayName;
        lines[i] = 'data: ' + JSON.stringify(parsed);
        rewritten = true;
      }
    } catch {
      // not valid JSON, skip
    }
  }

  if (rewritten) {
    logger.info(`Rewrote model in chunk: ${actualModel} → ${displayName}`);
  }
  return lines.join('\n');
}

// Helper to sanitize provider-specific identifiers from raw SSE chunks
function sanitizeChunk(chunk: string, displayName: string): string {
  let result = chunk;

  // 1. SSE event types: minimax:tool_call → content_block_start, other minimax:* → content_block_delta
  result = result.replace(/^event:\s*minimax:tool_call/gm, 'event: content_block_start');
  result = result.replace(/^event:\s*minimax:[a-z_]+/gm, 'event: content_block_delta');

  // 2. Tool ID format: call_function_xxx_1 → toolu_xxx_1 (Anthropic format, reversible)
  result = result.replace(/call_function_([a-z0-9]+)_(\d+)/g, 'toolu_$1_$2');

  // 3. Specific MiniMax model names
  result = result.replace(/MiniMax-M2\.5-highspeed/gi, displayName);
  result = result.replace(/MiniMax-M2\.5/gi, displayName);

  // 4. Catch-all: any remaining "MiniMax"/"minimax" text
  result = result.replace(/MiniMax/gi, 'Claude');
  result = result.replace(/minimax/gi, 'claude');

  // 5. Strip system_fingerprint from streaming chunks (leaks upstream deployment info)
  result = result.replace(/"system_fingerprint"\s*:\s*"[^"]*"\s*,?\s*/g, '');

  return result;
}

// Helper to sanitize provider-specific identifiers from non-streaming JSON response
function sanitizeResponseBody(body: any, displayName: string): any {
  let json = JSON.stringify(body);

  // Tool ID format: call_function_xxx_1 → toolu_xxx_1 (reversible)
  json = json.replace(/call_function_([a-z0-9]+)_(\d+)/g, 'toolu_$1_$2');

  // Specific MiniMax model names
  json = json.replace(/MiniMax-M2\.5-highspeed/gi, displayName);
  json = json.replace(/MiniMax-M2\.5/gi, displayName);

  // Catch-all
  json = json.replace(/MiniMax/gi, 'Claude');
  json = json.replace(/minimax/gi, 'claude');

  return JSON.parse(json);
}

// Core proxy handler
async function handleProxy(req: AuthenticatedRequest, res: Response, clientPath: string) {
  const correlationId = randomUUID();

  try {
    // Balance check
    if (!req.apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    // Expiry check
    if (req.apiKey.expiry && new Date() > new Date(req.apiKey.expiry)) {
      return res.status(403).json({
        error: 'API key expired',
        expired_at: req.apiKey.expiry,
        message: 'This API key has expired. Please contact admin to renew.'
      });
    }

    const budget = getEffectiveBudget(req.apiKey);
    if (!budget.allowed) {
      if (budget.type === 'rate') {
        return res.status(429).json({
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: `${req.body.model || 'Model'} is temporarily unavailable due to high demand. Please try again later.`,
          },
        });
      }
      return res.status(402).json({ error: 'Insufficient balance' });
    }

    // Model lookup
    const requestedModel = req.body.model;
    if (!requestedModel) {
      return res.status(400).json({ error: 'Model field is required' });
    }

    const model = await getModelByDisplayName(requestedModel);
    if (!model) {
      return res.status(404).json({ error: `Model '${requestedModel}' not found` });
    }

    // System prompt injection
    const modifiedBody = await injectSystemPrompt(req.body, model);

    // Swap model to actual upstream model
    modifiedBody.model = model.actualModel;

    // For OpenAI streaming, add stream_options to get usage in final chunk
    if (model.apiFormat === 'openai' && modifiedBody.stream === true) {
      modifiedBody.stream_options = { include_usage: true };
    }

    // Reverse-rewrite tool IDs in request body: toolu_xxx_1 → call_function_xxx_1
    // This restores MiniMax-format tool IDs that were rewritten in previous response turns
    let bodyStr = JSON.stringify(modifiedBody);
    bodyStr = bodyStr.replace(/toolu_([a-z0-9]+)_(\d+)/g, 'call_function_$1_$2');
    const finalBody = JSON.parse(bodyStr);

    // Build upstream request
    const headers = buildHeaders(model.apiFormat, model.apiKey);
    const isStreaming = modifiedBody.stream === true;
    const upstreamUrl = buildUpstreamUrl(model.apiUrl, clientPath);

    logger.info(`[${correlationId}] Proxying request to ${upstreamUrl} (format: ${model.apiFormat}, streaming: ${isStreaming})`);

    // Make upstream request (600s timeout to handle long LLM generations)
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(finalBody),
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
        // Try to extract a safe, generic reason from the raw error
        let safeDetail = '';
        try {
          const parsed = JSON.parse(rawError);
          const msg = parsed?.error?.message || parsed?.detail || '';
          // Only keep if it doesn't leak provider info
          if (msg && !/minimax|MiniMax/i.test(msg)) {
            safeDetail = `: ${msg}`;
          }
        } catch { /* ignore parse errors */ }
        errorType = 'invalid_request_error';
        errorMessage = `Invalid request${safeDetail}`;
      } else if (status === 401 || status === 403) {
        errorType = 'authentication_error';
        errorMessage = 'An authentication error occurred. Please contact the administrator.';
      } else {
        errorType = 'api_error';
        errorMessage = 'An unexpected error occurred. Please try again later.';
      }

      return res.status(status).json({
        type: 'error',
        error: {
          type: errorType,
          message: errorMessage,
        },
      });
    }

    // Debug: log all upstream response headers
    logger.info(`[${correlationId}] Upstream response headers:`, Object.fromEntries(upstreamResponse.headers.entries()));

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
  const safeHeaders = new Set([
    'content-type', 'cache-control', 'connection',
    'x-request-id', 'request-id',
  ]);
  const blockedPrefixes = ['x-minimax', 'x-mm-', 'cf-', 'server'];

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // Rewrite model-related headers to display name
    if (lowerKey === 'x-model-id' || lowerKey === 'anthropic-model' || lowerKey.includes('model')) {
      res.setHeader(key, displayName);
      return;
    }

    // Block provider-specific headers that could leak identity
    if (blockedPrefixes.some(p => lowerKey.startsWith(p))) return;
    if (lowerKey.includes('minimax')) return;
  });

  const parser = new StreamTokenParser(model.apiFormat);
  const reader = upstreamResponse.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    logger.error(`[${correlationId}] No readable stream from upstream`);
    return res.status(500).json({ error: 'No readable stream from upstream' });
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

        // Debug: log all chunks that contain "model" to see format
        if (chunk.includes('"model"')) {
          logger.info(`[${correlationId}] Chunk with model field: ${chunk.substring(0, 800)}`);
        }

        // Rewrite model name back to display name before forwarding
        const rewritten = rewriteModelInChunk(chunk, model.actualModel, displayName);

        // Sanitize provider-specific identifiers (SSE events, tool IDs, model names)
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

      await deductAndLog({
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

  // Swap model name back to display name
  if (responseBody.model) {
    logger.info(`[${correlationId}] Rewriting model in non-stream response: ${responseBody.model} → ${displayName}`);
    responseBody.model = displayName;
  }

  // Sanitize provider-specific identifiers (tool IDs, model names)
  responseBody = sanitizeResponseBody(responseBody, displayName);

  // Strip OpenAI system_fingerprint (leaks upstream deployment info)
  delete responseBody.system_fingerprint;

  // Selectively forward safe upstream headers — block provider-specific ones
  const blockedPrefixes = ['x-minimax', 'x-mm-', 'cf-', 'server'];

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // Rewrite model-related headers to display name
    if (lowerKey === 'x-model-id' || lowerKey === 'anthropic-model' || lowerKey.includes('model')) {
      res.setHeader(key, displayName);
      return;
    }

    // Block provider-specific headers that could leak identity
    if (blockedPrefixes.some(p => lowerKey.startsWith(p))) return;
    if (lowerKey.includes('minimax')) return;
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

    await deductAndLog({
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
