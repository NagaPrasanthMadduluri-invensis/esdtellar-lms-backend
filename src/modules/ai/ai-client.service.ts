import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@/config/configuration';

export interface AiJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface AiCompletionParams {
  system: string;
  user: string;
  /** When set, the model is asked for structured JSON matching this schema. */
  jsonSchema?: AiJsonSchema;
  maxTokens?: number;
}

/**
 * The OpenRouter client (spec ai-insights.md Wave 1).
 *
 * The ONE place that talks to an external model. Three invariants:
 *
 *  - **OFF by default.** With `ai.enabled` false or no API key it makes no call
 *    and returns null, so an unconfigured or un-enabled deployment spends
 *    nothing and sends nothing out (the same warn-and-degrade shape as email/R2).
 *  - **Never throws.** A recommendation is best-effort (§8.4); a model timeout,
 *    an HTTP error or malformed JSON returns null, never a 500 into a request.
 *  - **PII-agnostic.** It only sends the prompt it is handed. Keeping personal
 *    data out of that prompt is the feature layer's job, reviewed as its own
 *    boundary (spec §7); this layer must not be where PII leaks in.
 *
 * No SDK: OpenRouter's chat-completions endpoint is one HTTPS POST, the same
 * reasoning that put SESv2 and the Gmail API over `fetch` rather than a client
 * library.
 */
@Injectable()
export class AiClientService {
  private readonly logger = new Logger('AiClient');

  constructor(private readonly config: ConfigService) {}

  private get cfg(): AppConfig['ai'] {
    return this.config.getOrThrow<AppConfig['ai']>('ai');
  }

  /** True only when the feature is switched on AND a key is present. */
  isEnabled(): boolean {
    const { enabled, apiKey } = this.cfg;
    return enabled && apiKey.length > 0;
  }

  /** The configured model id, for stamping stored insights. */
  get model(): string {
    return this.cfg.model;
  }

  /**
   * One chat completion. Returns the assistant's text, or null when disabled or
   * on any failure. When `jsonSchema` is given the model is asked for structured
   * JSON (the raw string is returned for the caller to parse, or use
   * `completeJson`).
   */
  async complete(params: AiCompletionParams): Promise<string | null> {
    if (!this.isEnabled()) {
      this.logger.debug('AI disabled — skipping completion.');
      return null;
    }
    const cfg = this.cfg;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        max_tokens: params.maxTokens ?? cfg.maxOutputTokens,
        temperature: 0.4,
      };
      if (params.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: params.jsonSchema.name,
            strict: true,
            schema: params.jsonSchema.schema,
          },
        };
      }

      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter dashboard attribution — product origin and name only,
          // never anything that identifies a learner.
          'HTTP-Referer': this.config.get<string>('clientOrigin') ?? '',
          'X-Title': cfg.appTitle,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          `OpenRouter ${response.status}: ${detail.slice(0, 300)}`,
        );
        return null;
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    } catch (error) {
      this.logger.warn(
        `AI call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Like `complete`, but parses the result as JSON. Returns null on a failed
   * call or unparseable content. Tolerates a model that wraps its JSON in prose
   * or a code fence by extracting the first balanced object.
   */
  async completeJson<T>(params: AiCompletionParams): Promise<T | null> {
    const text = await this.complete(params);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as T;
        } catch {
          /* fall through */
        }
      }
      this.logger.warn('AI returned content that was not valid JSON.');
      return null;
    }
  }
}
