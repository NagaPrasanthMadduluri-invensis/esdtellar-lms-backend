import {
  Body,
  UnprocessableEntityException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { CurrentUser, PlatformAdmin, Public } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { AuthService, type PublicUser } from './auth.service';
import { authCookieOptions, clearCookieOptions } from './cookie.util';
import { ChangePasswordDto } from '@/modules/learner/dto/change-password.dto';
import { ImpersonateDto } from './dto/impersonate.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/profile.dto';
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
  /**
   * Retired with multi-tenancy, deliberately kept as an explicit refusal rather
   * than deleted. A public signup form cannot know which organization a learner
   * belongs to, and any default would place a stranger inside a real customer's
   * tenant. Accounts are created by an organization's admin.
   *
   * The body is intentionally NOT bound to RegisterDto: the global
   * ValidationPipe runs before the handler, so a DTO here would answer a
   * caller with a field-validation error instead of the actual reason.
   */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.UNPROCESSABLE_ENTITY)
  register(): never {
    throw new UnprocessableEntityException(
      'Self-service registration is unavailable. Ask your organization admin to add your account.',
    );
  }

  @Get('me')
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ user: PublicUser }> {
    return { user: await this.authService.me(user.userId, user) };
  }

  /**
   * The caller's own profile. Authenticated, ANY role — no `@Roles()`.
   *
   * Every portal's top-bar avatar opens this, so gating it to one audience
   * would give three of the four a dialog that 403s.
   */
  @Get('profile')
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.profile(user.userId);
  }

  /**
   * Edit your own profile.
   *
   * Identity comes from the token, so there is nothing here that lets one
   * person edit another — the same property `change-password` relies on.
   * `UpdateProfileDto` is deliberately narrow; read its docblock before adding
   * a field, particularly for `email` and `department`.
   *
   * One known and accepted cost: `firstName`/`lastName` are also JWT claims,
   * carried so the server-rendered shell can show a name without a round
   * trip. Renaming yourself therefore leaves the top bar showing the old name
   * until the next sign-in. Re-minting the token here would fix the label and
   * cost a silent session swap on a cosmetic edit, which is the worse trade.
   */
  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.userId, dto);
  }

  /**
   * Open a support session inside a tenant. PLATFORM ADMIN ONLY.
   *
   * Lives on the auth controller rather than beside the tenant directory
   * because what it does is mint a token and set a cookie — that is this
   * file's job, and putting it under `/platform/organizations` would also
   * have meant `OrganizationsModule` importing `AuthModule`, which is a cycle
   * (`AuthService` already depends on `OrganizationsService`).
   *
   * The response carries the tenant's name so the caller can say where it is
   * about to land, rather than navigating and letting the banner explain.
   */
  @PlatformAdmin()
  @Post('impersonate')
  @HttpCode(HttpStatus.OK)
  async impersonate(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: ImpersonateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, token, maxAgeSeconds, organization } =
      await this.authService.impersonate(actor, dto.organization_id);
    this.setAuthCookie(response, token, maxAgeSeconds);
    return { user, organization };
  }

  /**
   * End a support session.
   *
   * Deliberately NOT `@PlatformAdmin()`: the caller's token says they are a
   * tenant admin right now, so that guard would refuse the one request whose
   * whole purpose is getting back. Authorisation is `impersonatorId` on the
   * verified token, re-checked against the database in the service — the
   * claim says who to return to, the row says whether they may.
   */
  @Post('exit-impersonation')
  @HttpCode(HttpStatus.OK)
  async exitImpersonation(
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    const { user, token } = await this.authService.exitImpersonation(actor);
    this.setAuthCookie(response, token);
    return { user };
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

  /**
   * Change your own password. Authenticated, any role — no `@Roles()`.
   *
   * Previously `POST /api/learner/change-password` on a `@Roles('learner')`
   * controller, which meant a trainer got 403 from the only screen the product
   * has for this. Identity comes from the token, so there is nothing here that
   * lets one user change another's.
   */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.changePassword(
      user.userId,
      user.organizationId,
      dto,
    );
  }

  /**
   * `maxAgeSeconds` follows the TOKEN, not the configured default. A support
   * session's token dies in an hour; a week-long cookie around it would keep
   * the browser sending a credential the server has stopped accepting, which
   * the user experiences as being logged out at random.
   */
  private setAuthCookie(
    response: Response,
    token: string,
    maxAgeSeconds?: number,
  ): void {
    response.cookie(
      this.cookieName,
      token,
      authCookieOptions({
        maxAgeSeconds: maxAgeSeconds ?? this.tokenService.maxAgeSeconds,
        domain: this.cookieDomain,
        isProduction: this.isProduction,
      }),
    );
  }
}
