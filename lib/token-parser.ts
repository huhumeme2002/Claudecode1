import { TokenUsage } from './types';

export function parseOpenAIResponse(body: any): TokenUsage {
  const usage = body?.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

export function parseAnthropicResponse(body: any): TokenUsage {
  return {
    inputTokens: body?.usage?.input_tokens ?? 0,
    outputTokens: body?.usage?.output_tokens ?? 0,
  };
}

export class StreamTokenParser {
  private format: 'openai' | 'anthropic';
  private inputTokens = 0;
  private outputTokens = 0;
  private buffer = '';

  constructor(format: 'openai' | 'anthropic') {
    this.format = format;
  }

  processChunk(rawChunk: string): void {
    this.buffer += rawChunk;

    // Split on double newline (SSE event boundary)
    const parts = this.buffer.split('\n\n');
    // Keep the last incomplete part in buffer
    this.buffer = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          if (this.format === 'openai') {
            this.processOpenAIEvent(parsed);
          } else {
            this.processAnthropicEvent(parsed);
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    }
  }

  private processOpenAIEvent(parsed: any): void {
    if (parsed.usage) {
      this.inputTokens = parsed.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = parsed.usage.completion_tokens ?? this.outputTokens;
    }
  }

  private processAnthropicEvent(parsed: any): void {
    if (parsed.type === 'message_start' && parsed.message?.usage) {
      this.inputTokens = parsed.message.usage.input_tokens ?? 0;
    }
    if (parsed.type === 'message_delta' && parsed.usage) {
      this.outputTokens = parsed.usage.output_tokens ?? 0;
    }
  }

  getUsage(): TokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}
