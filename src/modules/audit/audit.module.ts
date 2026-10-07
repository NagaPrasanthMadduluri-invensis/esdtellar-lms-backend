import { Global, Module } from '@nestjs/common';

import { AdminAuditController } from './admin-audit.controller';
import { PlatformAuditController } from './platform-audit.controller';
import { AuditMiddleware } from './audit.middleware';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * `@Global()`, which `DatabaseModule`'s docblock claims to be the only one —
 * and the claim is now out of date rather than wrong to break.
 *
 * The reason is the middleware: it is applied in `AppModule.configure()`
 * and Nest resolves its dependencies from the module that applies it, so
 * `AuditService` has to be reachable from the root. The alternative is
 * importing AND exporting `AuditModule` in `AppModule`, which is the same
 * reachability with more ceremony.
 *
 * Nothing else should inject `AuditService`. Writing an audit row by hand is
 * how coverage becomes a thing somebody has to remember, which is exactly
 * what the middleware exists to prevent.
 */
@Global()
@Module({
  controllers: [AdminAuditController, PlatformAuditController],
  providers: [AuditService, AuditRepository, AuditMiddleware],
  exports: [AuditService, AuditMiddleware],
})
export class AuditModule {}
