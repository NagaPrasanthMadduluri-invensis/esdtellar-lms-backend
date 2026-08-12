import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

/**
 * TokenService is exported because the global AuthGuard depends on it to verify
 * incoming requests.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, TokenService],
  exports: [TokenService],
})
export class AuthModule {}
