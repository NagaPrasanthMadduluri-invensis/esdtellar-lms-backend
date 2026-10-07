import {
  Body,
  UnprocessableEntityException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { CurrentUser, PlatformAdmin, Public } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { AuthService, type PublicUser } from './auth.service';
import { authCookieOptions, clearCookieOptions } from './cookie.util';
import { ChangePasswordDto } from '@/modules/learner/dto/change-password.dto';
import { ImpersonateDto } from './dto/impersonate.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/profile.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordResetService } from './password-reset.service';
import { TokenService } from './token.service';
import { AUDIT_ACTOR } from '@/modules/audit/audit.middleware';

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly cookieDomain: string;
  private readonly isProduction: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly passwordReset: PasswordResetService,
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
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    /*
     * ATTRIBUTE THE SIGN-IN, succeeded or refused.
     *
     * This route is `@Public()`, so `AuthGuard` populates no `request.user`
     * and the audit middleware had nothing to record but "Unauthenticated"
     * with a NULL organization — which the org-scoped read then excluded,
     * so a tenant could not see its own sign-ins at all. A login is the
     * single event an admin most expects in an activity log.
     *
     * Declared BEFORE the attempt and from the ADDRESS, so a WRONG PASSWORD
     * is attributed too: "somebody tried to sign in as Priya and failed" is
     * the row that matters, and it is lost if only successes are named. The
     * lookup is by email alone and reveals nothing to the caller — the
     * response is unchanged and still cannot distinguish "no such user"
     * from "wrong password" (§5.3).
     */
    (request as unknown as Record<symbol, unknown>)[AUDIT_ACTOR] =
      await this.authService.auditActorFor(dto.email);

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

  /* ── Forgot password ─────────────────────────────────────────────────── */

  /**
   * `@Public()` by necessity — the whole point is that the caller cannot
   * sign in.
   *
   * ALWAYS 200, ALWAYS THE SAME SENTENCE, whether or not the address has an
   * account. §5.3 states the rule for login ("or the form becomes an
   * account-enumeration oracle") and this is the same oracle wearing a more
   * helpful-looking label: "no account with that email" is exactly the
   * message a well-meaning form would show, and it hands an attacker a
   * free membership check against any address they like.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: RequestPasswordResetDto,
    @Req() request: { ip?: string },
  ) {
    return this.passwordReset.request(dto.email, request.ip ?? null);
  }

  /**
   * Lets the page say "this link has expired" BEFORE asking for a new
   * password, rather than after the learner has typed it twice.
   *
   * Safe to leave public and unauthenticated: it answers only about a token
   * the caller already holds, and reveals nothing about any account.
   */
  @Public()
  @Get('reset-password/check')
  async checkResetToken(@Query('token') token: string) {
    if (!token) return { valid: false, reason: 'not_found' };
    return this.passwordReset.check(token);
  }

  /**
   * Sets the new password and ends every existing session.
   *
   * No cookie is issued here on purpose. Signing somebody straight in off a
   * link that arrived by email would make the link itself a credential, and
   * a forwarded or logged URL would become an account. They sign in with
   * the password they just chose, which is also the fastest way to find out
   * it works.
   */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.passwordReset.reset(dto.token, dto.newPassword);
  }
}
