import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { CurrentUser, Public } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { EmailOutboxRepository } from './email-outbox.repository';
import { MAIL_BRAND as C, FONT_STACK, PRODUCT_NAME } from './email-brand';
import { MUTABLE_GROUPS, UpdateEmailPreferencesDto } from './dto/email.dto';
import { escapeHtml } from './templates/layout';
import { readUnsubscribeToken } from './unsubscribe-token';

/**
 * Email preferences and unsubscribe.
 *
 * No `@Roles()` on the preference routes: all four audiences receive email,
 * so gating them to one would give three of them a control that 403s. And
 * your own email settings are not a capability an organization grants, so
 * there is no `@Permissions()` either. No route takes a user id — identity
 * comes from the token — so there is no parameter that could read or change
 * somebody else's.
 */
@Controller()
export class EmailController {
  constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly config: ConfigService,
  ) {}

  @Get('auth/email-preferences')
  async read(@CurrentUser() user: AuthenticatedUser) {
    const prefs = await this.repository.preferences(user.userId);
    return {
      preferences: {
        all_off: prefs.all_off === 1,
        groups_off: prefs.groups_off.split(',').filter(Boolean),
      },
      groups: MUTABLE_GROUPS,
    };
  }

  @Patch('auth/email-preferences')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateEmailPreferencesDto,
  ) {
    const current = await this.repository.preferences(user.userId);
    const allOff = dto.all_off === undefined ? current.all_off : dto.all_off ? 1 : 0;
    const groupsOff =
      dto.groups_off === undefined
        ? current.groups_off
        : [...new Set(dto.groups_off)]
            .filter((g) => (MUTABLE_GROUPS as readonly string[]).includes(g))
            .join(',');

    await this.repository.savePreferences(user.userId, allOff, groupsOff);
    return {
      preferences: {
        all_off: allOff === 1,
        groups_off: groupsOff.split(',').filter(Boolean),
      },
    };
  }

  /**
   * The link in an announcement's footer.
   *
   * `@Public()` because the person clicking is not signed in — that is the
   * whole point of an unsubscribe link, and requiring a login to stop
   * receiving mail is how a reader reaches for the spam button instead.
   *
   * The token is an HMAC and the worst a leaked one does is stop email
   * reaching its own owner. It cannot read anything and cannot turn email
   * back ON: re-subscribing is a signed-in operation.
   */
  @Public()
  @Get('email/unsubscribe')
  async unsubscribeGet(@Query('t') token: string, @Res() res: Response) {
    const ok = await this.apply(token);
    res.status(ok ? 200 : 400).type('html').send(this.page(ok));
  }

  /**
   * RFC 8058 one-click. Gmail and Yahoo POST here from their own UI when the
   * `List-Unsubscribe-Post` header is present, which is what keeps a reader
   * from using the spam button — and a spam complaint is what actually
   * damages the sending domain for every other tenant on it.
   */
  @Public()
  @Post('email/unsubscribe')
  @HttpCode(200)
  async unsubscribePost(@Query('t') token: string) {
    await this.apply(token);
    // Always 200. Telling a mail provider that a token was bad achieves
    // nothing and some of them retry on an error.
    return { ok: true };
  }

  private async apply(token: string): Promise<boolean> {
    const secret = this.config.get<string>('auth.jwtSecret') ?? '';
    const parsed = readUnsubscribeToken(secret, token);
    if (!parsed) return false;
    await this.repository.unsubscribe(parsed.userId, parsed.purpose);
    return true;
  }

  /**
   * A plain confirmation page, server-rendered.
   *
   * Deliberately not a redirect into the Next app: the person is not signed
   * in, so the app would bounce them to /login and the unsubscribe would
   * read as having failed.
   */
  private page(ok: boolean): string {
    const title = ok ? 'You are unsubscribed' : 'That link did not work';
    const body = ok
      ? 'You will not get these emails again. Account and security messages ' +
        'are still sent — those are not something we can switch off for you.'
      : 'The link may have been altered in transit. You can change your email ' +
        'settings from your profile once you are signed in.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:${C.canvas};font-family:${FONT_STACK};">
  <div style="max-width:460px;margin:80px auto;background:${C.surface};border:1px solid ${C.line};">
    <div style="background:${C.navy};padding:18px 28px;color:#fff;font-size:18px;font-weight:700;">${escapeHtml(PRODUCT_NAME)}</div>
    <div style="height:3px;background:${ok ? C.success : C.warning};"></div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 12px;font-size:20px;color:${C.ink};">${escapeHtml(title)}</h1>
      <p style="margin:0;font-size:14px;line-height:1.6;color:${C.text2};">${escapeHtml(body)}</p>
    </div>
  </div>
</body></html>`;
  }
}
