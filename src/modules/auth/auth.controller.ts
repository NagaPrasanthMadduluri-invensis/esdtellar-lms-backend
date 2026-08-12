import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { CurrentUser, Public } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { AuthService, type PublicUser } from './auth.service';
import { authCookieOptions, clearCookieOptions } from './cookie.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenService } from './token.service';

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly cookieDomain: string;
  private readonly isProduction: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    config: ConfigService,
  ) {
    this.cookieName = config.getOrThrow<string>('auth.cookieName');
    this.cookieDomain = config.getOrThrow<string>('auth.cookieDomain');
    this.isProduction = config.get<string>('nodeEnv') === 'production';
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    const { user, token } = await this.authService.login(dto);
    this.setAuthCookie(response, token);
    // The token is deliberately NOT in the body — it lives only in the
    // HttpOnly cookie, so client JavaScript never holds a credential.
    return { user };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    const { user, token } = await this.authService.register(dto);
    this.setAuthCookie(response, token);
    return { user };
  }

  @Get('me')
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ user: PublicUser }> {
    return { user: await this.authService.me(user.userId) };
  }

  /**
   * Clears the cookie. The legacy client had a `/logout` nav entry wired to a
   * no-op stub and no endpoint at all, so signing out never reached the server.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response): { ok: true } {
    response.clearCookie(
      this.cookieName,
      clearCookieOptions({
        domain: this.cookieDomain,
        isProduction: this.isProduction,
      }),
    );
    return { ok: true };
  }

  private setAuthCookie(response: Response, token: string): void {
    response.cookie(
      this.cookieName,
      token,
      authCookieOptions({
        maxAgeSeconds: this.tokenService.maxAgeSeconds,
        domain: this.cookieDomain,
        isProduction: this.isProduction,
      }),
    );
  }
}
