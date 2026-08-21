import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { hashPassword, verifyPassword } from '@/common/crypto/password.util';
import { CertificatesService } from '@/modules/certificates/certificates.service';
import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';
import { LearningHoursService } from '@/modules/learning-hours/learning-hours.service';

import type { ChangePasswordDto } from './dto/change-password.dto';
import {
  addDays,
  avatarColor,
  contentTypeOf,
  DUE_DAYS,
  formatDate,
  initialsOf,
  lastMonth as previousMonthKey,
  minutesToHours,
  modeOf,
  MONTHLY_GOAL_HOURS,
  parseScormDuration,
  parseTimestamp,
  POINTS_PER_LESSON,
  POINTS_PER_PASSED_ASSESSMENT,
  relativeTime,
  round1,
  skillTags,
  thisMonth as currentMonthKey,
  weeks as monthWeeks,
} from './learner.constants';
import { LearnerRepository } from './learner.repository';

/** Synthetic per-course metadata for the My Courses cards. */
const BADGE_DEFS = [
  { id: 'first_steps', tier: 'BRONZE', title: 'First Steps', desc: 'Completed your first course', icon: 'target' },
  { id: 'quick_learner', tier: null, title: 'Quick Learner', desc: 'Completed a course before its due date', icon: 'zap' },
  { id: 'assessment_topper', tier: 'GOLD', title: 'Assessment Topper', desc: 'Scored 90% or higher on an assessment', icon: 'trophy' },
  { id: 'perfectionist', tier: 'PLATINUM', title: 'Perfectionist', desc: 'Achieved a perfect 100% on an assessment', icon: 'perfect' },
  { id: 'committed_learner', tier: 'SILVER', title: 'Committed Learner', desc: 'Completed 3 or more courses', icon: 'books' },
  { id: 'scholar', tier: 'GOLD', title: 'Scholar', desc: 'Completed 5 or more courses', icon: 'scholar' },
  { id: 'feedback_hero', tier: null, title: 'Feedback Hero', desc: 'Submitted feedback on 3 or more courses', icon: 'feedback' },
  { id: 'high_flyer', tier: 'SILVER', title: 'High Flyer', desc: 'Earned 500 or more points', icon: 'rocket' },
  { id: 'learning_champion', tier: 'GOLD', title: 'Learning Champion', desc: 'Earned 1000 or more points', icon: 'crown' },
] as const;

interface BadgeStats {
  points: number;
  completedCourses: number;
  completedBeforeDue: number;
  hasScore90Plus: boolean;
  hasScore100: boolean;
  feedbackCount: number;
}

@Injectable()
export class LearnerService {
  constructor(
    private readonly repository: LearnerRepository,
    private readonly certificates: CertificatesService,
    private readonly hours: LearningHoursService,
    private readonly leaderboard_: LeaderboardService,
  ) {}

  /* ─────────────────────────────────────────────
     Shared: points + hours for every learner
  ───────────────────────────────────────────── */

  /* ─────────────────────────────────────────────
     GET /learner/courses
  ───────────────────────────────────────────── */

  async courses(userId: number) {
    const [rows, contentRows] = await Promise.all([
      this.repository.assignedCourses(userId),
      this.repository.courseContentTypes(userId),
    ]);

    // What each course actually holds, rather than a hard-coded assumption.
    const typesByCourse = new Map(
      contentRows.map((r) => [
        Number(r.course_id),
        (r.content_types || '').split(',').filter(Boolean),
      ]),
    );

    const courses = rows.map((row) => {
      const total = Number(row.total_lessons);
      const done = Number(row.completed_lessons);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const dueDate = addDays(row.assigned_at, DUE_DAYS);
      const types = typesByCourse.get(Number(row.course_id)) ?? [];
      const meta = {
        contentType: contentTypeOf(types),
        // Neither of these has a column to come from. They were invented per
        // course id; reporting null is honest, where a guess was not.
        category: null as string | null,
        isMandatory: false,
      };

      const bestScore = row.best_score !== null ? Number(row.best_score) : null;
      const hasAssessment =
        bestScore !== null || Number(row.assessment_count) > 0;
      const hasPassed =
        row.has_passed !== null ? Number(row.has_passed) === 1 : null;
      const hasFailed = pct === 100 && hasAssessment && hasPassed === false;

      let status: string;
      if (hasFailed) status = 'failed';
      else if (pct === 100) status = 'completed';
      else if (pct > 0) status = 'in-progress';
      else status = 'assigned';

      return {
        enrollmentId: row.enrollment_id,
        assignedAt: row.assigned_at,
        assignedFmt: formatDate(row.assigned_at),
        dueDate,
        dueFmt: formatDate(dueDate),
        dueShort: this.shortDate(dueDate),
        status,
        progressPct: pct,
        contentType: meta.contentType,
        category: meta.category,
        isMandatory: meta.isMandatory,
        totalMinutes: Number(row.total_minutes),
        bestScore,
        passingScore:
          row.passing_score !== null ? Number(row.passing_score) : 60,
        hasFailed,
        course: {
          id: row.course_id,
          name: row.name,
          description: row.description,
          // The list cards show course art too, so the thumbnail has to reach
          // them — only the detail endpoint used to return it.
          thumbnail_url: row.thumbnail_url,
        },
      };
    });

    const completed = courses.filter((c) => c.status === 'completed').length;
    const scores = courses
      .map((c) => c.bestScore)
      .filter((s): s is number => s !== null);

    const nextDeadline =
      courses
        .filter((c) => c.status !== 'completed')
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;

    return {
      overview: {
        totalAssigned: courses.length,
        inProgress: courses.filter((c) => c.status === 'in-progress').length,
        completed,
        assigned: courses.filter((c) => c.status === 'assigned').length,
        failed: courses.filter((c) => c.status === 'failed').length,
        avgScore: scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null,
        nextDeadline: nextDeadline
          ? {
              short: nextDeadline.dueShort,
              courseName: nextDeadline.course.name,
            }
          : null,
      },
      journeyPct: courses.length
        ? Math.round((completed / courses.length) * 100)
        : 0,
      courses,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/dashboard
  ───────────────────────────────────────────── */

  async dashboard(userId: number) {
    const [rows, standings, lessonMinutes, scormBuckets, attempts] =
      await Promise.all([
        this.repository.assignedCourses(userId),
        this.leaderboard_.standings(),
        this.hours.lessonMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.hours.scormMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.repository.recentAttempts(userId, 5),
      ]);

    const enrolled = rows.map((row) => {
      const total = Number(row.total_lessons);
      const done = Number(row.completed_lessons);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const isDone = total > 0 && done >= total;

      return {
        enrollment_id: row.enrollment_id,
        assigned_at: row.assigned_at,
        last_activity: row.last_activity ?? null,
        status: isDone ? 'completed' : done > 0 ? 'in-progress' : 'assigned',
        progress_percentage: pct,
        due_date: addDays(row.assigned_at, DUE_DAYS),
        course: {
          id: row.course_id,
          name: row.name,
          description: row.description,
          thumbnail_url: row.thumbnail_url,
          total_lessons: total,
          completed_lessons: done,
        },
      };
    });

    // Points and rank come from the shared leaderboard calculation, so the
    // figure on the dashboard is the same one the leaderboard shows.
    const myStanding = standings.entries.find((e) => e.id === userId) ?? null;
    const points = myStanding?.points ?? 0;
    const rank = myStanding?.rank ?? standings.entries.length + 1;

    const minutes = lessonMinutes.find((row) => Number(row.user_id) === userId);
    const scorm = scormBuckets.get(userId);

    const [lessonEvents, assessmentEvents, assignmentEvents] = await Promise.all([
      this.repository.lessonEvents(userId, 3),
      this.repository.assessmentEvents(userId, 3),
      this.repository.assignmentEvents(userId, 3),
    ]);

    const recentActivity = [
      ...lessonEvents.map((e) => ({
        type: 'lesson',
        title: e.title,
        course: e.course_name,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
      })),
      ...assessmentEvents.map((e) => ({
        type: 'assessment',
        title: e.title,
        course: e.course_name,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
        passed: Number(e.is_passed) === 1,
      })),
      ...assignmentEvents.map((e) => ({
        type: 'assignment',
        title: `Assigned: ${e.title}`,
        course: e.title,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
      })),
    ]
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
      .slice(0, 8);

    const journey = enrolled
      .slice()
      .sort((a, b) => (a.assigned_at || '').localeCompare(b.assigned_at || ''))
      .map((c) => ({
        course_id: c.course.id,
        name: c.course.name,
        status: c.status,
        progress_percentage: c.progress_percentage,
      }));

    return {
      enrolled_courses: enrolled,
      stats: {
        assigned_courses: enrolled.length,
        in_progress_courses: enrolled.filter((c) => c.status === 'in-progress').length,
        completed_courses: enrolled.filter((c) => c.status === 'completed').length,
        yet_to_start: enrolled.filter((c) => c.status === 'assigned').length,
        hours_this_month: minutesToHours(Number(minutes?.this_month ?? 0)),
        hours_goal: MONTHLY_GOAL_HOURS,
        hours_all_time: minutesToHours(
          Number(minutes?.all_time ?? 0) + (scorm?.all ?? 0),
        ),
        completed_assessments: myStanding?.badges ?? 0,
      },
      points,
      rank,
      rank_of: standings.entries.length,
      badges: myStanding?.badges ?? 0,
      skill_tags: skillTags(enrolled.map((c) => c.course.name)).slice(0, 5),
      continue_learning:
        enrolled
          .filter((c) => c.status === 'in-progress')
          .sort((a, b) =>
            (b.last_activity || '').localeCompare(a.last_activity || ''),
          )[0] ?? null,
      journey: {
        courses: journey,
        completed: journey.filter((c) => c.status === 'completed').length,
        total: journey.length,
      },
      upcoming_deadlines: enrolled
        .filter((c) => c.status !== 'completed')
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .slice(0, 4)
        .map((c) => ({
          course_id: c.course.id,
          name: c.course.name,
          due_date: c.due_date,
          status: c.status,
        })),
      recent_activity: recentActivity,
      recentAttempts: attempts,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/courses/:courseId
  ───────────────────────────────────────────── */

  async courseDetail(userId: number, courseId: number) {
    const assignment = await this.repository.findAssignment(userId, courseId);
    if (!assignment) {
      throw new ForbiddenException('You are not enrolled in this course');
    }

    const course = await this.repository.findActiveCourse(courseId);
    if (!course) throw new NotFoundException('Course not found');

    const [modules, lessons, assessments, latestAttempts] = await Promise.all([
      this.repository.activeModules(courseId),
      this.repository.lessonsWithStatus(courseId, userId),
      this.repository.courseAssessments(courseId, userId),
      this.repository.latestAttemptsForCourse(courseId, userId),
    ]);

    const byModule = new Map<number, typeof lessons>();
    for (const lesson of lessons) {
      const key = Number(lesson.module_id);
      const list = byModule.get(key);
      if (list) list.push(lesson);
      else byModule.set(key, [lesson]);
    }

    let totalLessons = 0;
    let completedLessons = 0;
    // Sequential unlock: a module opens only once the previous one is finished,
    // and within a module each lesson opens once the previous is completed.
    let prevModuleComplete = true;

    const shapedModules = modules.map((module) => {
      const moduleLessons = byModule.get(Number(module.id)) ?? [];
      const locked = !prevModuleComplete;

      const withLocks = moduleLessons.map((lesson, index) => ({
        ...lesson,
        is_locked: locked
          ? true
          : index === 0
            ? false
            : moduleLessons[index - 1].progress_status !== 'completed',
      }));

      const completedCount = withLocks.filter(
        (l) => l.progress_status === 'completed',
      ).length;

      totalLessons += withLocks.length;
      completedLessons += completedCount;
      prevModuleComplete = !locked && completedCount === withLocks.length;

      return {
        ...module,
        lessons: withLocks,
        total_count: withLocks.length,
        completed_count: completedCount,
      };
    });

    const latestByAssessment = new Map(
      latestAttempts.map((a) => [
        Number(a.assessment_id),
        {
          percentage: a.percentage,
          is_passed: a.is_passed,
          submitted_at: a.submitted_at,
        },
      ]),
    );

    const progressPct =
      totalLessons > 0
        ? Math.round((completedLessons / totalLessons) * 100)
        : 0;

    return {
      course: {
        ...(course as Record<string, unknown>),
        modules_count: modules.length,
        lessons_count: totalLessons,
      },
      enrollment: {
        status: progressPct === 100 ? 'completed' : 'active',
        progress_percentage: progressPct,
        granted_at: assignment.assignedAt,
      },
      modules: shapedModules,
      assessments: assessments.map((a) => ({
        ...a,
        last_attempt: latestByAssessment.get(Number(a.id)) ?? null,
      })),
      assessmentsUnlocked: totalLessons > 0 && completedLessons === totalLessons,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/lessons/:lessonId
  ───────────────────────────────────────────── */

  async lesson(userId: number, lessonId: number) {
    const lesson = await this.repository.findLessonWithModule(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (!(await this.repository.isAssigned(userId, Number(lesson.course_id)))) {
      throw new ForbiddenException('Access denied');
    }

    // One query gives every lesson in the course with its completion state,
    // which is enough to resolve both the lock check and the next-lesson link.
    const all = await this.repository.lessonsWithStatus(
      Number(lesson.course_id),
      userId,
    );

    const inModule = all.filter(
      (l) => Number(l.module_id) === Number(lesson.module_id),
    );
    const position = inModule.findIndex((l) => Number(l.id) === lessonId);

    if (position > 0) {
      if (inModule[position - 1].progress_status !== 'completed') {
        throw new ForbiddenException(
          'This lesson is locked. Complete the previous lesson first.',
        );
      }
    } else if (position === 0) {
      const moduleIds = [...new Set(all.map((l) => Number(l.module_id)))];
      const moduleIndex = moduleIds.indexOf(Number(lesson.module_id));
      if (moduleIndex > 0) {
        const prevId = moduleIds[moduleIndex - 1];
        const prev = all.filter((l) => Number(l.module_id) === prevId);
        const done = prev.filter(
          (l) => l.progress_status === 'completed',
        ).length;
        if (prev.length > 0 && done < prev.length) {
          throw new ForbiddenException(
            'This lesson is locked. Complete all lessons in the previous module first.',
          );
        }
      }
    }

    const flatIndex = all.findIndex((l) => Number(l.id) === lessonId);
    const next = flatIndex >= 0 ? all[flatIndex + 1] : undefined;
    const current = all[flatIndex];

    return {
      lesson: {
        id: lesson.id,
        title: lesson.title,
        description: lesson.description,
        content_type: lesson.content_type,
        content_url: lesson.content_url,
        // Booleans, not the R2 keys themselves: the player asks
        // GET /learner/lessons/:id/media for a signed URL when this is true.
        has_video: Boolean(lesson.video_key),
        has_captions: Boolean(lesson.caption_key),
        scorm_package_id: lesson.scorm_package_id ?? null,
        duration_minutes: lesson.duration_minutes,
        module: { title: lesson.module_title },
      },
      progress_status: current?.progress_status ?? 'not_started',
      next_lesson_id: next ? Number(next.id) : null,
    };
  }

  async completeLesson(userId: number, lessonId: number) {
    const lesson = await this.repository.findLessonCourse(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const courseId = Number(lesson.course_id);
    if (!(await this.repository.isAssigned(userId, courseId))) {
      throw new ForbiddenException('Access denied');
    }

    await this.repository.markLessonComplete(userId, lessonId);
    // Finishing the last lesson can complete the course. Best-effort.
    await this.certificates.autoIssue(userId, courseId);

    return { message: 'Lesson marked as complete' };
  }

  /* ─────────────────────────────────────────────
     GET /learner/progress
  ───────────────────────────────────────────── */

  async progress(userId: number) {
    const [assigned, lessonProgress, scormRows, minutes, scormBuckets, attempts] =
      await Promise.all([
        this.repository.assignedCourses(userId),
        this.repository.courseLessonProgress(userId),
        this.repository.scormForAssignedCourses(userId),
        this.hours.lessonMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.hours.scormMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.repository.allAttempts(userId),
      ]);

    const progressByCourse = new Map(
      lessonProgress.map((r) => [Number(r.course_id), r]),
    );

    const scormByCourse = new Map<number, typeof scormRows>();
    for (const row of scormRows) {
      const key = Number(row.course_id);
      const list = scormByCourse.get(key);
      if (list) list.push(row);
      else scormByCourse.set(key, [row]);
    }

    const courseHistory = assigned.map((course) => {
      const courseId = Number(course.course_id);
      const counts = progressByCourse.get(courseId);
      const total = Number(counts?.total ?? 0);
      const done = Number(counts?.done ?? 0);
      const scorm = scormByCourse.get(courseId) ?? [];

      let minutesSpent = Number(course.completed_minutes);
      let scormScore: number | null = null;
      let scormPassed: boolean | null = null;
      let partialBonus = 0;

      for (const row of scorm) {
        if (row.total_time) minutesSpent += parseScormDuration(row.total_time);

        if (row.score_raw !== null) {
          const raw = Number(row.score_raw);
          const max = row.score_max ? Number(row.score_max) : 100;
          const pct = max > 0 ? Math.round((raw / max) * 100) : raw;
          if (scormScore === null || pct > scormScore) scormScore = pct;
        }

        if (row.success_status === 'passed' || row.lesson_status === 'passed') {
          scormPassed = true;
        } else if (
          (row.success_status === 'failed' || row.lesson_status === 'failed') &&
          scormPassed !== true
        ) {
          scormPassed = false;
        }

        const isDone =
          row.completion_status === 'completed' ||
          row.lesson_status === 'passed' ||
          row.lesson_status === 'completed';
        if (!isDone && row.cmi_data && total > 0) {
          try {
            const cmi = JSON.parse(row.cmi_data) as { progress_measure?: string };
            const pm = parseFloat(String(cmi.progress_measure ?? 0));
            if (pm > 0) partialBonus += pm * (1 / total) * 100;
          } catch {
            /* malformed CMI blob — ignore the partial bonus */
          }
        }
      }

      const rawPct = total > 0 ? (done / total) * 100 + partialBonus : 0;
      const pct = Math.min(Math.round(rawPct), done >= total ? 100 : 99);

      const quizScore =
        course.best_score !== null ? Number(course.best_score) : null;
      const score = quizScore ?? scormScore;
      const hasPassed =
        course.has_passed !== null
          ? Number(course.has_passed) === 1
          : scormPassed;

      let status: string;
      if (done === 0 && partialBonus === 0) status = 'not started';
      else if (done < total) status = 'in progress';
      else if (hasPassed === false) status = 'failed';
      else status = 'completed';

      const h = Math.floor(minutesSpent / 60);
      const m = Math.round(minutesSpent % 60);

      return {
        id: courseId,
        name: course.name,
        type: scorm.length > 0 ? 'SCORM' : 'VIDEO',
        status,
        progress: pct,
        score,
        timeSpent: minutesSpent < 1 ? null : h > 0 ? `${h}h ${m}m` : `${m}m`,
        hasPassed,
      };
    });

    const mine = minutes.find((r) => Number(r.user_id) === userId);
    const scorm = scormBuckets.get(userId);
    const allTimeHours = round1(
      Number(mine?.all_time ?? 0) / 60 + (scorm?.all ?? 0) / 60,
    );
    const thisMonth = round1(
      Number(mine?.this_month ?? 0) / 60 + (scorm?.thisMonth ?? 0) / 60,
    );
    const lastMonth = round1(
      Number(mine?.last_month ?? 0) / 60 + (scorm?.lastMonth ?? 0) / 60,
    );

    const scores = courseHistory
      .map((c) => c.score)
      .filter((s): s is number => s !== null);

    const best = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      const key = `${attempt.course_name}::${attempt.assessment_title}`;
      const existing = best.get(key);
      if (!existing || Number(attempt.score) > Number(existing.score)) {
        best.set(key, attempt);
      }
    }

    const [lessonEvents, assessEvents, assignEvents, scormEvents] =
      await Promise.all([
        this.repository.lessonEvents(userId, 5),
        this.repository.assessmentEvents(userId, 5),
        this.repository.assignmentEvents(userId, 100),
        this.repository.scormEvents(userId, 5),
      ]);

    const timeline = [
      ...lessonEvents.map((e) => ({
        type: 'lesson', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
      })),
      ...assessEvents.map((e) => ({
        type: 'assessment', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
        passed: Number(e.is_passed) === 1,
      })),
      ...assignEvents.map((e) => ({
        type: 'assignment', title: `Assigned: ${e.title}`, course: e.title,
        time: e.event_time, timeLabel: relativeTime(e.event_time),
        dateLabel: formatDate(e.event_time),
      })),
      ...scormEvents.map((e) => ({
        type: 'scorm', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
        scormStatus: e.completion_status || e.lesson_status,
      })),
    ]
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
      .slice(0, 15);

    const completed = courseHistory.filter((c) => c.status === 'completed');
    const passedCount = attempts.filter(
      (a) => Number(a.is_passed) === 1,
    ).length;

    return {
      summary: {
        assigned: courseHistory.length,
        completed: completed.length,
        completionRate: courseHistory.length
          ? Math.round((completed.length / courseHistory.length) * 100)
          : 0,
        avgScore: scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null,
        bestScore: scores.length ? Math.max(...scores) : null,
        allTimeHours,
      },
      courseHistory,
      assessmentPerformance: {
        avgScore: attempts.length
          ? Math.round(
              attempts.reduce((s, a) => s + Number(a.score), 0) / attempts.length,
            )
          : null,
        bestScore: attempts.length
          ? Math.max(...attempts.map((a) => Number(a.score)))
          : null,
        passRate: attempts.length
          ? Math.round((passedCount / attempts.length) * 100)
          : null,
        attempts: [...best.values()].map((a) => ({
          courseName: a.course_name,
          assessmentTitle: a.assessment_title,
          score: Number(a.score),
          passed: Number(a.is_passed) === 1,
        })),
      },
      learningHours: {
        thisMonth,
        lastMonth,
        allTime: allTimeHours,
        goal: MONTHLY_GOAL_HOURS,
        goalPct: Math.min(
          Math.round((thisMonth / MONTHLY_GOAL_HOURS) * 100),
          100,
        ),
        diff: round1(thisMonth - lastMonth),
      },
      skills: skillTags(completed.map((c) => c.name)),
      timeline,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/achievements
  ───────────────────────────────────────────── */

  async achievements(userId: number) {
    const [standings, assigned, attempts, lessonEvents, passedEvents] =
      await Promise.all([
        this.leaderboard_.standings(),
        this.repository.assignedCourses(userId),
        this.repository.allAttempts(userId),
        this.repository.lessonEvents(userId, 10),
        this.repository.assessmentEvents(userId, 100, true),
      ]);

    const myStanding = standings.entries.find((e) => e.id === userId) ?? null;
    const points = myStanding?.points ?? 0;
    const rank = myStanding?.rank ?? standings.entries.length + 1;

    let completedCourses = 0;
    let completedBeforeDue = 0;
    for (const course of assigned) {
      const total = Number(course.total_lessons);
      const done = Number(course.completed_lessons);
      if (total > 0 && done >= total) {
        completedCourses++;
        const due = addDays(course.assigned_at, DUE_DAYS);
        if (course.last_activity && course.last_activity.slice(0, 10) <= due) {
          completedBeforeDue++;
        }
      }
    }

    const stats: BadgeStats = {
      points,
      completedCourses,
      completedBeforeDue,
      hasScore90Plus: attempts.some((a) => Number(a.score) >= 90),
      hasScore100: attempts.some((a) => Number(a.score) === 100),
      feedbackCount: 0,
    };

    const badges = BADGE_DEFS.map((badge) => ({
      ...badge,
      earned: this.hasBadge(badge.id, stats),
    }));
    const next = badges.find((b) => !b.earned) ?? null;

    const pointsHistory = [
      ...lessonEvents.map((e) => ({
        activity: 'Lesson Completed',
        detail: e.title,
        course: e.course_name,
        date: formatDate(e.event_time),
        points: POINTS_PER_LESSON,
        type: 'lesson',
      })),
      ...passedEvents.map((e) => ({
        activity: 'Assessment Passed',
        detail: e.title,
        course: e.course_name,
        date: formatDate(e.event_time),
        points: POINTS_PER_PASSED_ASSESSMENT,
        type: 'assessment',
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20);

    return {
      summary: {
        points,
        rank,
        rankOf: standings.entries.length,
        earnedCount: badges.filter((b) => b.earned).length,
      },
      badges,
      nextBadge: next ? { ...next, hint: this.badgeHint(next.id, stats) } : null,
      pointsHistory,
    };
  }

  private hasBadge(id: string, s: BadgeStats): boolean {
    switch (id) {
      case 'first_steps': return s.completedCourses >= 1;
      case 'quick_learner': return s.completedBeforeDue >= 1;
      case 'assessment_topper': return s.hasScore90Plus;
      case 'perfectionist': return s.hasScore100;
      case 'committed_learner': return s.completedCourses >= 3;
      case 'scholar': return s.completedCourses >= 5;
      case 'feedback_hero': return s.feedbackCount >= 3;
      case 'high_flyer': return s.points >= 500;
      case 'learning_champion': return s.points >= 1000;
      default: return false;
    }
  }

  private badgeHint(id: string, s: BadgeStats): string {
    const plural = (n: number) => (n !== 1 ? 's' : '');
    switch (id) {
      case 'first_steps': return `Complete ${1 - s.completedCourses} more course`;
      case 'quick_learner': return 'Finish a course before its due date';
      case 'assessment_topper': return 'Score 90% or higher on any assessment';
      case 'perfectionist': return 'Score 100% on any assessment';
      case 'committed_learner': return `Complete ${3 - s.completedCourses} more course${plural(3 - s.completedCourses)}`;
      case 'scholar': return `Complete ${5 - s.completedCourses} more course${plural(5 - s.completedCourses)}`;
      case 'feedback_hero': return `Submit feedback on ${3 - s.feedbackCount} more course${plural(3 - s.feedbackCount)}`;
      case 'high_flyer': return `Earn ${500 - s.points} more points`;
      case 'learning_champion': return `Earn ${1000 - s.points} more points`;
      default: return '';
    }
  }

  /* ─────────────────────────────────────────────
     GET /learner/leaderboard
  ───────────────────────────────────────────── */

  async leaderboard(userId: number) {
    const { byPoints, byMonth, recognition } = await this.leaderboard_.standings();

    const decorate = (e: (typeof byPoints)[number]) => ({
      id: e.id,
      name: e.name,
      initials: initialsOf(e.firstName, e.lastName),
      dept: e.dept,
      color: avatarColor(e.name),
      allTimeRank: e.rank,
      monthRank: e.monthRank,
      allTimePoints: e.points,
      monthPoints: e.monthPoints,
      badges: e.badges,
      isYou: e.id === userId,
    });

    const allLearners = byPoints.map(decorate);
    const top3 = allLearners.slice(0, 3);
    const podium = [
      top3[1] ? { ...top3[1], podiumPos: 2 } : null,
      top3[0] ? { ...top3[0], podiumPos: 1 } : null,
      top3[2] ? { ...top3[2], podiumPos: 3 } : null,
    ].filter(Boolean);

    const withYou = (card: { id: number } | null) =>
      card ? { ...card, isYou: card.id === userId } : null;

    return {
      me: allLearners.find((l) => l.isYou) ?? null,
      recognition: {
        learnerOfMonth: withYou(recognition.learnerOfMonth),
        quickLearner: withYou(recognition.quickLearner),
        assessmentTopper: withYou(recognition.assessmentTopper),
      },
      podium,
      allLearners,
      departments: [
        'All Departments',
        ...new Set(byPoints.map((l) => l.dept).filter(Boolean)),
      ].sort((a, b) =>
        a === 'All Departments' ? -1 : b === 'All Departments' ? 1 : a.localeCompare(b),
      ),
      byMonth: byMonth.map(decorate),
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/learning-hours
  ───────────────────────────────────────────── */

  async learningHours(userId: number) {
    const [me, profiles, minutes, scormBuckets, courseHours, contentRows] =
      await Promise.all([
      this.repository.findUser(userId),
      this.repository.allLearnerProfiles(),
      this.hours.lessonMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
      this.hours.scormMinutes(currentMonthKey(), previousMonthKey(), monthWeeks()),
      this.repository.monthlyHoursByCourse(userId, currentMonthKey()),
      this.repository.courseContentTypes(userId),
    ]);

    const myDept = me?.department || 'Unknown';
    const minutesByUser = new Map(
      minutes.map((row) => [Number(row.user_id), row]),
    );

    /** Total hours for a learner in a period, lessons + SCORM. */
    const hours = (
      id: number,
      pick: (row: (typeof minutes)[number]) => number,
      scormPick: (b: { all: number; thisMonth: number; lastMonth: number; weeks: number[] }) => number,
    ) => {
      const row = minutesByUser.get(id);
      const scorm = scormBuckets.get(id);
      const lessonMins = row ? Number(pick(row)) : 0;
      const scormMins = scorm ? scormPick(scorm) : 0;
      return round1((lessonMins + scormMins) / 60);
    };

    const thisMonth = hours(userId, (r) => r.this_month, (b) => b.thisMonth);
    const lastMonth = hours(userId, (r) => r.last_month, (b) => b.lastMonth);
    const allTime = hours(userId, (r) => r.all_time, (b) => b.all);
    const goalPct = Math.min(
      Math.round((thisMonth / MONTHLY_GOAL_HOURS) * 100),
      100,
    );

    const peers = profiles
      .filter((p) => (p.department || 'Unknown') === myDept)
      .map((p) => {
        const tm = hours(Number(p.id), (r) => r.this_month, (b) => b.thisMonth);
        const gp = Math.min(Math.round((tm / MONTHLY_GOAL_HOURS) * 100), 100);
        return {
          id: Number(p.id),
          name: `${p.first_name} ${p.last_name}`,
          dept: p.department,
          thisMonth: tm,
          lastMonth: hours(Number(p.id), (r) => r.last_month, (b) => b.lastMonth),
          allTime: hours(Number(p.id), (r) => r.all_time, (b) => b.all),
          goalPct: gp,
          status: gp >= 100 ? 'On Track' : gp >= 60 ? 'Close' : 'Behind',
          isYou: Number(p.id) === userId,
        };
      })
      .sort((a, b) => b.thisMonth - a.thisMonth || b.allTime - a.allTime);

    const myRank = peers.findIndex((p) => p.isYou) + 1;
    const depts = [
      ...new Set(profiles.map((p) => p.department || 'Unknown')),
    ].sort();

    const orgOverview = depts.map((dept) => {
      const members = profiles.filter(
        (p) => (p.department || 'Unknown') === dept,
      );
      let total = 0;
      let onTrack = 0;
      for (const member of members) {
        const h = hours(Number(member.id), (r) => r.this_month, (b) => b.thisMonth);
        total += h;
        if (h >= MONTHLY_GOAL_HOURS) onTrack++;
      }
      return {
        dept,
        totalHours: round1(total),
        avgHours: members.length ? round1(total / members.length) : 0,
        onTrack,
        total: members.length,
        isYourDept: dept === myDept,
      };
    });

    const weeklyTrend = monthWeeks().map((week, index) => {
      const entry: Record<string, string | number> = { week: week.label };
      for (const dept of depts) {
        const members = profiles.filter(
          (p) => (p.department || 'Unknown') === dept,
        );
        let total = 0;
        for (const member of members) {
          total += hours(
            Number(member.id),
            (r) => [r.w1, r.w2, r.w3, r.w4][index],
            (b) => b.weeks[index],
          );
        }
        entry[dept] = round1(total);
      }
      return entry;
    });

    /* Training-mode breakdown for this month. */
    const typesByCourse = new Map(
      contentRows.map((r) => [
        Number(r.course_id),
        (r.content_types || '').split(',').filter(Boolean),
      ]),
    );

    const modeMap: Record<string, number> = {};
    for (const row of courseHours) {
      const mode = modeOf(typesByCourse.get(Number(row.course_id)) ?? []);
      modeMap[mode] = (modeMap[mode] ?? 0) + Number(row.hrs);
    }
    const scormHours = round1((scormBuckets.get(userId)?.thisMonth ?? 0) / 60);
    if (scormHours > 0) {
      modeMap['eLearning / SCORM'] =
        (modeMap['eLearning / SCORM'] ?? 0) + scormHours;
    }
    const totalModeHours =
      Object.values(modeMap).reduce((s, v) => s + v, 0) || 1;

    let statusLabel: string;
    if (goalPct >= 100) statusLabel = 'Goal Reached!';
    else if (goalPct >= 80) statusLabel = 'Almost There';
    else if (goalPct >= 50) statusLabel = 'On Track';
    else statusLabel = 'Behind';

    return {
      summary: {
        thisMonth, lastMonth, allTime, goalPct, goal: MONTHLY_GOAL_HOURS,
        remaining: Math.max(0, round1(MONTHLY_GOAL_HOURS - thisMonth)),
        diff: round1(thisMonth - lastMonth),
        deptRank: myRank, deptTotal: peers.length, dept: myDept,
        gapToFirst:
          myRank === 1 ? 0 : Math.max(0, round1((peers[0]?.thisMonth ?? 0) - thisMonth)),
        statusLabel,
      },
      weeklyTrend,
      depts,
      // Order by hours, not a fixed list — the modes are derived now, so a
      // hard-coded ordering would drop any mode not in it.
      modeBreakdown: Object.keys(modeMap)
        .filter((m) => modeMap[m] > 0)
        .sort((a, b) => modeMap[b] - modeMap[a])
        .map((mode) => ({
          mode,
          hours: round1(modeMap[mode]),
          pct: Math.round((modeMap[mode] / totalModeHours) * 100),
          // No colour: the client picks from the brand ramp. The hex values
          // that used to be here were off-palette (TASTE §10.1).
        })),
      deptPeers: peers,
      orgOverview,
    };
  }

  /* ─────────────────────────────────────────────
     POST /learner/change-password
  ───────────────────────────────────────────── */

  async changePassword(userId: number, dto: ChangePasswordDto) {
    const rules = {
      minLength: dto.newPassword.length >= 8,
      uppercase: /[A-Z]/.test(dto.newPassword),
      number: /[0-9]/.test(dto.newPassword),
      special: /[^A-Za-z0-9]/.test(dto.newPassword),
    };

    if (!Object.values(rules).every(Boolean)) {
      throw new UnprocessableEntityException({
        message: 'New password does not meet strength requirements',
        errors: {
          minLength: rules.minLength ? null : 'Must be at least 8 characters',
          uppercase: rules.uppercase ? null : 'Must contain at least one uppercase letter',
          number: rules.number ? null : 'Must contain at least one number',
          special: rules.special ? null : 'Must contain at least one special character',
        },
      });
    }

    const user = await this.repository.findActiveWithPassword(userId);
    if (!user) throw new NotFoundException('User not found');

    if (!verifyPassword(dto.currentPassword, user.password)) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new UnprocessableEntityException(
        'New password must be different from your current password',
      );
    }

    await this.repository.updatePassword(userId, hashPassword(dto.newPassword));
    return { message: 'Password updated successfully' };
  }

  /* ── helpers ── */

  private shortDate(iso: string): string {
    return parseTimestamp(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
  }
}
