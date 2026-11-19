import { Module } from '@nestjs/common';

import { AiClientService } from './ai-client.service';
import { AiInsightsRepository } from './ai-insights.repository';
import { AiInsightsService } from './ai-insights.service';

/**
 * The AI foundation (spec ai-insights.md Wave 1).
 *
 * Exports the OpenRouter client and the insights engine for the verticals to
 * import. No controllers of its own — a surface that triggers generation belongs
 * to the vertical that defines what is generated. OFF by default: see
 * `AiClientService`.
 */
@Module({
  providers: [AiClientService, AiInsightsService, AiInsightsRepository],
  exports: [AiClientService, AiInsightsService],
})
export class AiModule {}
