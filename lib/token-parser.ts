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

  constructor(format: 'openai' | 'anthropic') {
    this.format = format;
  }

  processChunk(data: string): void {
    try {
      if (this.format === 'openai') {
        this.processOpenAIChunk(data);
      } else {
        this.processAnthropicChunk(data);
      }
    } catch {
      // Ignore parse errors in stream chunks
    }
  }

  private processOpenAIChunk(data: string): void {
    const parsed = JSON.parse(data);
    if (parsed.usage) {
      this.inputTokens = parsed.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = parsed.usage.completion_tokens ?? this.outputTokens;
    }
  }

  private processAnthropicChunk(data: string): void {
    const parsed = JSON.parse(data);
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
