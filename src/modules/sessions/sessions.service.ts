import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type {
  RosterAddDto,
  SaveAttendanceDto,
  SessionDto,
} from './dto/session.dto';
import { SessionsRepository, type AttendanceRow } from './sessions.repository';

@Injectable()
export class SessionsService {
  constructor(private readonly repository: SessionsRepository) {}

  async list() {
    const rows = (await this.repository.list()) as Record<string, unknown>[];
    return {
      sessions: rows.map((row) => ({
        ...row,
        course_id: row.course_id ? Number(row.course_id) : null,
        capacity: Number(row.capacity),
        roster_count: Number(row.roster_count ?? 0),
      })),
    };
  }

  async get(sessionId: number) {
    const session = await this.repository.findWithCourse(sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session };
  }

  async create(dto: SessionDto) {
    const id = await this.repository.createSession(this.toRow(dto));
    return { session: await this.repository.findWithCourse(id) };
  }

  async update(sessionId: number, dto: SessionDto) {
    await this.repository.updateSession(sessionId, this.toRow(dto));
    const session = await this.repository.findWithCourse(sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session };
  }

  async remove(sessionId: number) {
    await this.repository.deleteSession(sessionId);
    return { message: 'Session deleted' };
  }

  /* ── Roster ── */

  async roster(sessionId: number) {
    const [enrolled, available] = await Promise.all([
      this.repository.enrolled(sessionId),
      this.repository.available(sessionId),
    ]);
    return { enrolled, available };
  }

  async addToRoster(sessionId: number, dto: RosterAddDto) {
    if (dto.enroll_all && dto.department) {
      await this.repository.enrollDepartment(sessionId, dto.department);
    } else if (dto.user_id) {
      await this.repository.addToRoster(sessionId, dto.user_id);
    } else {
      throw new BadRequestException('user_id or enroll_all+department required');
    }
    return this.roster(sessionId);
  }

  async removeFromRoster(sessionId: number, userId: number) {
    await this.repository.removeFromRoster(sessionId, userId);
    return this.roster(sessionId);
  }

  /* ── Attendance ── */

  async attendance(sessionId: number) {
    return this.shapeAttendance(await this.repository.attendance(sessionId));
  }

  async saveAttendance(
    sessionId: number,
    adminId: number,
    dto: SaveAttendanceDto,
  ) {
    await this.repository.upsertAttendance(
      sessionId,
      // The legacy handler passed `payload.id`, which does not exist on the JWT
      // (the claim is `userId`), so marked_by was always stored as null and the
      // "marked by" name never rendered. Fixed here.
      adminId,
      dto.lock ? 1 : 0,
      dto.records ?? [],
    );

    return this.shapeAttendance(await this.repository.attendance(sessionId));
  }

  /* ── Learner ── */

  async listForLearner(userId: number) {
    return { sessions: await this.repository.listForLearner(userId) };
  }

  /* ── Helpers ── */

  private shapeAttendance(rows: AttendanceRow[]) {
    return {
      records: rows.map((row) => ({
        user_id: Number(row.id),
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        department: row.department,
        status: row.status || null,
        join_time: row.join_time || '',
        notes: row.notes || '',
        is_locked: Number(row.is_locked) === 1,
        marked_by: row.marked_by ? Number(row.marked_by) : null,
        marker_name: row.marker_first
          ? `${row.marker_first} ${row.marker_last}`
          : null,
      })),
      is_locked: rows.some((row) => Number(row.is_locked) === 1),
    };
  }

  private toRow(dto: SessionDto) {
    return {
      title: dto.title,
      sessionType: dto.session_type ?? 'ILT',
      department: dto.department ?? null,
      courseId: dto.course_id ? Number(dto.course_id) : null,
      capacity: dto.capacity ? Number(dto.capacity) : 20,
      trainer: dto.trainer,
      venueUrl: dto.venue_url,
      date: dto.date,
      startTime: dto.start_time,
      endTime: dto.end_time,
      description: dto.description ?? null,
      status: dto.status ?? 'upcoming',
    };
  }
}
