import { Global, Module } from '@nestjs/common';

import { DatabaseService } from './database.service';
import { PublicIdService } from './public-id.service';

/**
 * Global so feature modules can inject DatabaseService without re-importing
 * this module. It is the ONLY global module in the application — everything
 * else is imported explicitly by the module that needs it.
 *
 * PublicIdService rides here too: it is a generic DB utility (resolve a public
 * UUID to its integer id, 0046) that controllers across many modules need, and
 * keeping it global means they inject it without a module import, exactly like
 * DatabaseService.
 */
@Global()
@Module({
  providers: [DatabaseService, PublicIdService],
  exports: [DatabaseService, PublicIdService],
})
export class DatabaseModule {}
