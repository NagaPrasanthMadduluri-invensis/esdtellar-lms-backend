import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AlertLevel = 'critical' | 'high' | 'info';

export interface Alert {
  /** Identifies the alert for repeat-suppression, e.g. 'api-down'. */
  key: string;
  level: AlertLevel;
  title: string;
  lines?: string[];
  /** Minimum gap before the same key is sent again. Default 15 minutes. */
  repeatAfterMinutes?: number;
}

const LEVEL_TAG: Record<AlertLevel, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  info: '🔵 INFO',
};

/** Email addresses and IPv4/IPv6 addresses never leave for Cliq. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

/**
 * Operational alerts to the team's Zoho Cliq channel (§10.50).
 *
 * THREE RULES, all load-bearing:
 * - **Never throws and never blocks the caller** (§8.4). An alert about a
 *   failure must not become a second failure; every send is fire-and-forget
 *   with a 5-second timeout.
 * - **No personal data.** Cliq is another company's service, so a name, email
 *   or IP address sent there would be a new transfer of personal data. Callers
 *   pass user and organization NUMBERS; every line is scrubbed of anything
 *   shaped like an email or IP address before it is sent, as a backstop.
 * - **Repeats are suppressed per key** (default 15 minutes), so a bad night
 *   is a handful of messages, not hundreds. The memory is per process: the API
 *   and the worker each own different alerts, so they do not double up.
 *
 * Posts as the bot (CLIQ_BOT_NAME). If Cliq answers that the bot is not a
 * member of the channel, it retries once as the token's owner, so an alert is
 * never lost to a channel-membership mistake.
 *
 * With no CLIQ_WEBHOOK_TOKEN it is off: alerts are logged locally and nothing
 * is sent.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger('Alerts');
  private readonly url: string;
  private readonly token: string;
  private readonly bot: string;
  private readonly environment: string;
  private readonly sentUntil = new Map<string, number>();
  private readonly counters = new Map<string, number[]>();
  private warnedBot = false;

  constructor(config: ConfigService) {
    this.url = config.get<string>('alerts.cliqUrl') ?? '';
    this.token = config.get<string>('alerts.cliqToken') ?? '';
    this.bot = config.get<string>('alerts.cliqBot') ?? '';
    // Which environment an alert came from, without personal data: the app's
    // public host (spectralms.edstellar.com, or localhost in development).
    const origin = config.get<string>('clientOrigin') ?? '';
    let host = origin;
    try { host = new URL(origin).host; } catch { /* keep the raw value */ }
    this.environment = host || 'unknown environment';
  }

  get enabled(): boolean {
    return Boolean(this.url && this.token);
  }

  /** Fire-and-forget. Returns immediately; never throws. */
  send(alert: Alert): void {
    const now = Date.now();
    if ((this.sentUntil.get(alert.key) ?? 0) > now) return;
    this.sentUntil.set(alert.key, now + (alert.repeatAfterMinutes ?? 15) * 60_000);
    void this.post(alert).catch((error) =>
      this.logger.warn(`Alert "${alert.key}" not sent: ${String(error)}`),
    );
  }

  /**
   * Count an event in a sliding window and return how many happened inside it.
   * In memory, per process; used for the burst alerts.
   */
  count(key: string, windowMs: number): number {
    const now = Date.now();
    const list = (this.counters.get(key) ?? []).filter((t) => t > now - windowMs);
    list.push(now);
    this.counters.set(key, list);
    if (this.counters.size > 5000) this.prune(now - windowMs);
    return list.length;
  }

  /* ── Burst detectors called from the request path ─────────────────── */

  /** An unexpected (non-HttpException) 5xx. 5 within 5 minutes is a burst. */
  recordServerError(route: string, errorName: string): void {
    const n = this.count('server-errors', 5 * 60_000);
    if (n >= 5) {
      this.send({
        key: 'server-errors',
        level: 'high',
        title: 'Burst of server errors',
        lines: [`${n} unexpected server errors in the last 5 minutes.`, `Latest: ${route} (${errorName})`, 'Check: pm2 logs edstellar_lms_api'],
      });
    }
  }

  /**
   * A wrong password. Ten for one account in 15 minutes, or thirty for
   * addresses that do not exist (someone trying lists of emails), is a burst.
   */
  recordFailedLogin(userId: number | null, organizationId: number | null): void {
    if (userId) {
      const n = this.count(`login-u${userId}`, 15 * 60_000);
      if (n >= 10) {
        this.send({
          key: `failed-login-u${userId}`,
          level: 'high',
          title: 'Repeated failed sign-ins for one account',
          lines: [`${n} failed sign-ins in 15 minutes for user #${userId} (organization #${organizationId ?? '?'}).`, 'Possible password guessing. The account is rate-limited automatically; check the audit log.'],
        });
      }
      return;
    }
    const n = this.count('login-unknown', 15 * 60_000);
    if (n >= 30) {
      this.send({
        key: 'failed-login-unknown',
        level: 'high',
        title: 'Many sign-ins for addresses that do not exist',
        lines: [`${n} sign-in attempts for unknown email addresses in 15 minutes.`, 'Possible credential stuffing. Consider raising the Cloudflare security level.'],
      });
    }
  }

  /** A sign-in, two-step or password-reset rate limit was tripped. */
  recordRateLimit(rule: string, route: string): void {
    if (!/^(login|mfa|forgot|reset)/.test(rule)) return;
    this.send({
      key: `rate-limit-${rule}`,
      level: 'high',
      title: 'Sign-in rate limit tripped',
      lines: [`Rule "${rule}" refused requests on ${route}.`, 'Requests are being blocked automatically. Repeated alerts suggest an attack; see the incident response plan, runbook R1 or R7.'],
    });
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private format(alert: Alert): string {
    const scrub = (t: string) =>
      t.replace(EMAIL_RE, '[email removed]').replace(IPV4_RE, '[ip removed]').replace(IPV6_RE, '[ip removed]');
    const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    return [
      `${LEVEL_TAG[alert.level]} · *${scrub(alert.title)}*`,
      ...(alert.lines ?? []).map(scrub),
      `_${this.environment} · ${when}_`,
    ].join('\n');
  }

  private async post(alert: Alert): Promise<void> {
    const text = this.format(alert);
    if (!this.enabled) {
      this.logger.log(`[not sent: Cliq not configured] ${text.replace(/\n/g, ' | ')}`);
      return;
    }
    const attempt = async (withBot: boolean) => {
      const q = new URLSearchParams({ zapikey: this.token });
      if (withBot && this.bot) q.set('bot_unique_name', this.bot);
      return fetch(`${this.url}?${q.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
    };
    let res = await attempt(true);
    if (res.status === 400 && this.bot) {
      const body = await res.text();
      if (body.includes('bot_not_member')) {
        if (!this.warnedBot) {
          this.logger.warn(`Cliq bot "${this.bot}" is not a member of the channel; posting as the token owner. Add the bot to the channel.`);
          this.warnedBot = true;
        }
        res = await attempt(false);
      }
    }
    if (!res.ok) {
      this.logger.warn(`Cliq answered ${res.status} for alert "${alert.key}".`);
    }
  }

  private prune(before: number): void {
    for (const [k, list] of this.counters) {
      const kept = list.filter((t) => t > before);
      if (kept.length) this.counters.set(k, kept);
      else this.counters.delete(k);
    }
  }
}
