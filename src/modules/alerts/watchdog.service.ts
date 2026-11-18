import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { incidentDeadlines } from '@/common/incidents';

import { AlertsRepository } from './alerts.repository';
import { AlertsService } from './alerts.service';

/**
 * The WORKER's half of the watch (§10.50), driven by pg-boss jobs:
 * - every minute: write the worker heartbeat, then check the API's health
 *   endpoint over the local port. Two failures in a row is "API down"; the
 *   first success after that is "API recovered".
 * - hourly: post open security incidents whose legal clocks are overdue or due
 *   within 24 hours (each incident and clock at most every 12 hours).
 *
 * The worker checks the API because a process cannot report its own death;
 * the API checks the worker for the same reason (ApiWatchService).
 */
@Injectable()
export class WorkerWatchService {
  private readonly logger = new Logger('Watchdog');
  private failures = 0;
  private alertedDown = false;
  private readonly port: number;

  constructor(
    private readonly repo: AlertsRepository,
    private readonly alerts: AlertsService,
    config: ConfigService,
  ) {
    this.port = config.get<number>('port') ?? 3001;
  }

  async minute(): Promise<void> {
    try {
      await this.repo.beat('worker');
    } catch (error) {
      this.logger.warn(`Heartbeat not written: ${String(error)}`);
    }
    let ok = false;
    let detail = '';
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/health`, { signal: AbortSignal.timeout(5000) });
      ok = res.ok;
      detail = ok ? '' : `health check answered HTTP ${res.status}`;
    } catch (error) {
      detail = error instanceof Error && error.name === 'TimeoutError' ? 'no answer within 5 seconds' : 'connection refused or failed';
    }
    if (ok) {
      if (this.alertedDown) {
        this.alerts.send({ key: `api-recovered-${Date.now()}`, level: 'info', title: 'API is responding again', lines: [`Back after ${this.failures} failed checks.`] });
      }
      this.failures = 0;
      this.alertedDown = false;
      return;
    }
    this.failures += 1;
    if (this.failures >= 2 && !this.alertedDown) {
      this.alertedDown = true;
      this.alerts.send({
        key: 'api-down',
        level: 'critical',
        title: 'API is not responding',
        lines: [`${this.failures} health checks in a row failed (${detail}).`, 'Users cannot sign in or load data. Check: pm2 status, pm2 logs edstellar_lms_api. Incident response plan, runbook R6.'],
        repeatAfterMinutes: 30,
      });
    }
  }

  async incidentClocks(): Promise<void> {
    const rows = await this.repo.openIncidents();
    for (const r of rows) {
      for (const clock of incidentDeadlines(r)) {
        if (clock.state !== 'overdue' && clock.state !== 'due_soon') continue;
        this.alerts.send({
          key: `incident-${r.id}-${clock.key}-${clock.state}`,
          level: clock.state === 'overdue' ? 'critical' : 'high',
          title: `${r.ref_no}: ${clock.label} is ${clock.state === 'overdue' ? 'OVERDUE' : 'due within 24 hours'}`,
          lines: [`Due ${clock.due_at?.replace('T', ' ').slice(0, 16)} UTC. Severity ${r.severity}.`, 'Open the incident in Platform → Security Incidents.'],
          repeatAfterMinutes: 12 * 60,
        });
      }
    }
  }
}

/**
 * The API's half of the watch (§10.50): every minute, read the worker's
 * heartbeat and alert if it is more than 5 minutes old. Silent until a worker
 * has beaten at least once, so a development machine that never runs the
 * worker does not alert, and silent for the first 5 minutes after the API
 * starts, while a deploy restarts both.
 */
@Injectable()
export class ApiWatchService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private alertedStale = false;

  constructor(
    private readonly repo: AlertsRepository,
    private readonly alerts: AlertsService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.check(), 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (Date.now() - this.startedAt < 5 * 60_000) return;
    let age: number | null = null;
    try {
      age = await this.repo.secondsSinceBeat('worker');
    } catch {
      return; // the database being down is the API's own problem, reported elsewhere
    }
    if (age === null) return;
    if (age > 300) {
      if (!this.alertedStale) {
        this.alertedStale = true;
        this.alerts.send({
          key: 'worker-down',
          level: 'critical',
          title: 'Background worker has stopped',
          lines: [`No heartbeat for ${Math.round(age / 60)} minutes.`, 'Emails, reminders and nightly jobs are not running. Check: pm2 status, pm2 logs edstellar_lms_worker; restart with pm2 restart edstellar_lms_worker.'],
          repeatAfterMinutes: 60,
        });
      }
    } else if (this.alertedStale) {
      this.alertedStale = false;
      this.alerts.send({ key: `worker-recovered-${Date.now()}`, level: 'info', title: 'Background worker is running again' });
    }
  }
}
