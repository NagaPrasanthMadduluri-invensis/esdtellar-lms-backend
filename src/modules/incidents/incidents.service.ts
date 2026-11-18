import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  incidentDeadlines,
  nextDeadline,
  type IncidentDeadline,
} from '@/common/incidents';
import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import type {
  CreateIncidentDto,
  NotifyClientsDto,
  UpdateIncidentDto,
} from './dto/incident.dto';
import {
  IncidentsRepository,
  type IncidentRow,
  type IncidentWrite,
} from './incidents.repository';

/** Human names for the fields an update can change, for the timeline. */
const FIELD_LABEL: Record<string, string> = {
  title: 'title', description: 'description', severity: 'severity', status: 'status',
  discovered_at: 'discovery time', assessment: 'assessment', assessed_at: 'assessment time',
  data_categories: 'data categories', individuals_affected: 'people affected',
  cause: 'cause', containment: 'containment', regulator_notified_at: 'regulator notified',
  regulator_reference: 'regulator reference', individuals_notified_at: 'individuals notified',
  organization_ids: 'affected organizations',
};

/**
 * The security incident register (0066). Platform-only: every route is
 * @PlatformAdmin, and an incident may span several tenants.
 *
 * Everything time-critical is DERIVED: `deadlines` comes from
 * common/incidents.ts on every read, so a row can never carry a due date that
 * disagrees with the times it was computed from.
 *
 * Every write also writes a timeline event, so the post-incident review can
 * see what was known when, and by whom.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly repository: IncidentsRepository,
    private readonly notifications: NotificationsService,
    /** Cliq: a new incident is posted at once (§10.50). */
    private readonly alerts: AlertsService,
  ) {}

  async list() {
    const rows = await this.repository.list();
    const incidents = rows.map((r) => this.shape(r));
    const open = incidents.filter((i) => i.status !== 'closed');
    return {
      incidents,
      counts: {
        total: incidents.length,
        open: open.length,
        notifiable: incidents.filter((i) => i.assessment === 'notifiable').length,
        overdue: open.filter((i) => i.deadlines.some((d) => d.state === 'overdue')).length,
      },
    };
  }

  async get(id: number) {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('Incident not found');
    const events = await this.repository.events(id);
    return { incident: { ...this.shape(row), events } };
  }

  async options() {
    return { organizations: await this.repository.organizationOptions() };
  }

  async create(dto: CreateIncidentDto, actor: AuthenticatedUser) {
    const discovered = dto.discovered_at ?? new Date().toISOString();
    if (Date.parse(discovered) > Date.now() + 60_000) {
      throw new UnprocessableEntityException('The discovery time cannot be in the future.');
    }
    const refNo = await this.repository.nextRefNo(new Date().getUTCFullYear());
    const id = await this.repository.create({
      ref_no: refNo,
      title: dto.title.trim(),
      description: dto.description ?? null,
      severity: dto.severity ?? 'medium',
      status: 'open',
      discovered_at: discovered,
      data_categories: dto.data_categories ?? null,
      individuals_affected: dto.individuals_affected ?? null,
      cause: dto.cause ?? null,
      containment: dto.containment ?? null,
      created_by: actor.userId,
    });
    if (dto.organization_ids?.length) {
      await this.repository.setOrganizations(id, dto.organization_ids);
    }
    await this.event(id, actor, 'created', `Logged ${refNo}.`);
    // The title is written by Edstellar staff and may name a client; Cliq gets
    // the reference, severity and counts only (§10.50).
    this.alerts.send({
      key: `incident-created-${id}`,
      level: dto.severity === 'critical' || dto.severity === 'high' ? 'critical' : 'high',
      title: `Security incident logged: ${refNo} (${dto.severity ?? 'medium'})`,
      lines: [
        `${dto.organization_ids?.length ?? 0} client organization(s) named as affected.`,
        'Legal clocks are running from the discovery time. Open Platform → Security Incidents; follow the Incident Response Plan.',
      ],
    });
    return this.get(id);
  }

  async update(id: number, dto: UpdateIncidentDto, actor: AuthenticatedUser) {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException('Incident not found');

    const patch: IncidentWrite = {};
    const copy = <K extends keyof IncidentWrite>(k: K, v: IncidentWrite[K] | undefined) => {
      if (v !== undefined) patch[k] = v;
    };
    copy('title', dto.title?.trim());
    copy('description', dto.description);
    copy('severity', dto.severity);
    copy('discovered_at', dto.discovered_at);
    copy('data_categories', dto.data_categories);
    copy('individuals_affected', dto.individuals_affected);
    copy('cause', dto.cause);
    copy('containment', dto.containment);
    copy('regulator_notified_at', dto.regulator_notified_at);
    copy('regulator_reference', dto.regulator_reference);
    copy('individuals_notified_at', dto.individuals_notified_at);

    /*
     * The assessment's TIME matters as much as its outcome: the PDPC's 3-day
     * clock starts from it. A changed outcome is stamped now unless the caller
     * states when it was really decided; going back to undecided clears it.
     */
    if (dto.assessment !== undefined && dto.assessment !== existing.assessment) {
      patch.assessment = dto.assessment;
      patch.assessed_at =
        dto.assessment === 'undecided' ? null : dto.assessed_at ?? new Date().toISOString();
    } else if (dto.assessed_at !== undefined && existing.assessment !== 'undecided') {
      patch.assessed_at = dto.assessed_at;
    }

    if (dto.status !== undefined && dto.status !== existing.status) {
      patch.status = dto.status;
      patch.closed_at = dto.status === 'closed' ? new Date().toISOString() : null;
    }

    const changed = Object.keys(patch).filter(
      (k) => k !== 'closed_at' && k !== 'assessed_at' &&
        String((existing as unknown as Record<string, unknown>)[k] ?? '') !==
          String((patch as Record<string, unknown>)[k] ?? ''),
    );

    await this.repository.update(id, patch);

    let orgsChanged = false;
    if (dto.organization_ids !== undefined) {
      const before = existing.organizations.map((o) => o.id).sort().join(',');
      const after = [...new Set(dto.organization_ids)].sort().join(',');
      if (before !== after) {
        await this.repository.setOrganizations(id, [...new Set(dto.organization_ids)]);
        orgsChanged = true;
      }
    }

    const names = [...changed, ...(orgsChanged ? ['organization_ids'] : [])].map(
      (k) => FIELD_LABEL[k] ?? k,
    );
    if (names.length) {
      const detail =
        patch.assessment !== undefined && patch.assessment !== existing.assessment
          ? ` Assessment: ${patch.assessment.replace('_', ' ')}.`
          : patch.status !== undefined && patch.status !== existing.status
            ? ` Status: ${patch.status}.`
            : '';
      await this.event(id, actor, 'updated', `Updated ${names.join(', ')}.${detail}`);
    }
    return this.get(id);
  }

  async addNote(id: number, note: string, actor: AuthenticatedUser) {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException('Incident not found');
    await this.event(id, actor, 'note', note.trim());
    return this.get(id);
  }

  /**
   * Tell every admin of every affected organization (0066). Their admins are
   * the data controller's people: they may owe their own regulator and staff a
   * notice, and our contract says we tell them without undue delay.
   *
   * Bell + email, and the email ignores the recipient's preferences
   * (`security_incident_notice` is UNSUPPRESSABLE). Each organization gets its
   * own notify() so the row is filed under that organization. The first send
   * stamps `clients_notified_at`; a later update is recorded on the timeline
   * without moving the original time, because the clock was met (or missed)
   * by the first notice.
   */
  async notifyClients(id: number, dto: NotifyClientsDto, actor: AuthenticatedUser) {
    const incident = await this.repository.findById(id);
    if (!incident) throw new NotFoundException('Incident not found');
    if (incident.organizations.length === 0) {
      throw new UnprocessableEntityException(
        'Add the affected organizations to the incident before notifying them.',
      );
    }

    const facts = [
      { label: 'Reference', value: incident.ref_no },
      { label: 'Discovered', value: this.readable(incident.discovered_at) },
      { label: 'Data involved', value: incident.data_categories || 'Being established' },
      { label: 'Status', value: incident.status },
    ];
    const body = [
      dto.message.trim(),
      `As your data processor, Edstellar is informing you so you can assess your own obligations, which may include notifying your data protection regulator and the affected people. Reply to this email or contact your Edstellar account manager for the full details and our assistance.`,
    ].join('\n\n');

    let recipients = 0;
    const reached: string[] = [];
    for (const org of incident.organizations) {
      const adminIds = await this.notifications.adminsOf(org.id);
      if (adminIds.length === 0) continue;
      recipients += adminIds.length;
      reached.push(`${org.name} (${adminIds.length})`);
      await this.notifications.notify({
        userIds: adminIds,
        organizationId: org.id,
        type: 'security_incident_notice',
        title: `Security incident notice: ${incident.title}`,
        subjectName: incident.title,
        body,
        facts,
        link: null,
        actorName: 'Edstellar',
        subjectType: 'security_incident',
        subjectId: incident.id,
      });
    }

    if (recipients === 0) {
      throw new UnprocessableEntityException(
        'None of the affected organizations has an active admin account to notify. Contact them directly and record it in a note.',
      );
    }

    if (!incident.clients_notified_at) {
      await this.repository.update(id, { clients_notified_at: new Date().toISOString() });
    }
    await this.event(
      id,
      actor,
      'clients_notified',
      `Notified ${recipients} admin${recipients === 1 ? '' : 's'}: ${reached.join(', ')}. Message: ${dto.message.trim()}`,
    );
    return { ...(await this.get(id)), notified: recipients };
  }

  private async event(id: number, actor: AuthenticatedUser, kind: string, note: string) {
    await this.repository.addEvent({
      incidentId: id,
      actorUserId: actor.userId,
      actorName: actorLabel(actor),
      kind,
      note,
    });
  }

  private readable(ts: string): string {
    const t = Date.parse(ts.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(t)
      ? ts
      : new Date(t).toUTCString().replace(':00 GMT', ' UTC');
  }

  private shape(r: IncidentRow) {
    const deadlines: IncidentDeadline[] = incidentDeadlines({
      discovered_at: r.discovered_at,
      assessment: r.assessment,
      assessed_at: r.assessed_at,
      clients_notified_at: r.clients_notified_at,
      regulator_notified_at: r.regulator_notified_at,
      individuals_notified_at: r.individuals_notified_at,
      affected_organizations: r.organizations.length,
    });
    return {
      ...r,
      individuals_affected:
        r.individuals_affected === null ? null : Number(r.individuals_affected),
      // A closed incident's open clocks are history, not a call to action.
      deadlines,
      next_deadline: r.status === 'closed' ? null : nextDeadline(deadlines),
    };
  }
}
