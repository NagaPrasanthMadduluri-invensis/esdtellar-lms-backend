import { Global, Module } from '@nestjs/common';

import { DatabaseService } from './database.service';

/**
 * Global so feature modules can inject DatabaseService without re-importing
 * this module. It is the ONLY global module in the application — everything
 * else is imported explicitly by the module that needs it.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
