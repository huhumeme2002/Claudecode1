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
  if (!chunk.includes(actualModel)) return chunk;

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

      // OpenAI format: top-level model field
      if (parsed.model === actualModel) {
        parsed.model = displayName;
        lines[i] = 'data: ' + JSON.stringify(parsed);
        rewritten = true;
      }

      // Anthropic format: message_start event has message.model
      if (parsed.type === 'message_start' && parsed.message?.model === actualModel) {
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
          error: 'Rate budget exhausted',
          message: `Budget limit reached. Resets at ${budget.windowResetAt!.toISOString()}`,
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

    // Build upstream request
    const headers = buildHeaders(model.apiFormat, model.apiKey);
    const isStreaming = modifiedBody.stream === true;
    const upstreamUrl = buildUpstreamUrl(model.apiUrl, clientPath);

    logger.info(`[${correlationId}] Proxying request to ${upstreamUrl} (format: ${model.apiFormat}, streaming: ${isStreaming})`);

    // Make upstream request
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedBody)
    });

    // Handle upstream errors (4xx/5xx) - do NOT deduct balance
    if (!upstreamResponse.ok) {
      logger.error(`[${correlationId}] Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
      const errorBody = await upstreamResponse.text();
      return res.status(upstreamResponse.status).send(errorBody);
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
    return res.status(500).json({ error: 'Internal proxy error', message: error.message });
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

  // Copy upstream headers but rewrite model-related ones
  const headerEntries = Array.from(upstreamResponse.headers.entries());
  logger.info(`[${correlationId}] Checking ${headerEntries.length} upstream headers for model rewrite`);

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'x-model-id' || lowerKey === 'anthropic-model' || lowerKey.includes('model')) {
      logger.info(`[${correlationId}] Rewriting header ${key}: ${value} → ${displayName}`);
      res.setHeader(key, displayName);
    }
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

        // Forward chunk to client
        res.write(rewritten);
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
  const responseBody: any = await upstreamResponse.json();

  // Swap model name back to display name
  if (responseBody.model) {
    logger.info(`[${correlationId}] Rewriting model in non-stream response: ${responseBody.model} → ${displayName}`);
    responseBody.model = displayName;
  }

  // Copy upstream headers but rewrite model-related ones
  const headerEntries = Array.from(upstreamResponse.headers.entries());
  logger.info(`[${correlationId}] Checking ${headerEntries.length} upstream headers for model rewrite`);

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'x-model-id' || lowerKey === 'anthropic-model' || lowerKey.includes('model')) {
      logger.info(`[${correlationId}] Rewriting header ${key}: ${value} → ${displayName}`);
      res.setHeader(key, displayName);
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
