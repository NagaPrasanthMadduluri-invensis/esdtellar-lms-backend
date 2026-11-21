/**
 * Media (CONTEXT.md §5 Thumbnail, Upload limit, Resource; BACKEND §10.8,
 * §10.10). Local-disk images (course thumbnail, organization logo, profile
 * picture) are fully exercised. Everything that needs R2 object storage
 * answers the documented 503 here, because the test runtime has no R2.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, RUNTIME, signIn, type Agent } from './helpers';
import { assign, buildCourse, limitedAdmin, PNG_1X1, type BuiltCourse } from './support/2';

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const FAKE_PNG = Buffer.from('<html><body>not an image at all</body></html>');
const uploads = () => join(RUNTIME, 'uploads');

describe('media', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let learnerB: Agent;
  let noUpload: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    learnerB = await signIn(app, fx.B.learner);
    noUpload = (await limitedAdmin(app, adminA, fx.A, ['manage_courses'])).agent;
  });
  afterAll(async () => { await app.close(); });

  describe('course thumbnail and organization logo (local disk)', () => {
    it('stores a real PNG, serves it without sign-in, keeps it across a rename, and deletes it', async () => {
      const up = await adminA.post('/api/admin/media/course-thumbnail').attach('image', PNG_1X1, { filename: 'cover.png', contentType: 'image/png' });
      expect(up.status).toBe(200);
      expect(up.body.url).toMatch(/^\/uploads\/course-thumbnails\/[0-9a-f-]{36}\.png$/);
      const file = join(uploads(), 'course-thumbnails', up.body.url.split('/').pop());
      expect(existsSync(file)).toBe(true);
      const served = await anon(app).get(up.body.url);
      expect(served.status).toBe(200);
      expect(Buffer.compare(served.body as Buffer, PNG_1X1)).toBe(0);

      // Attached by the course save; a rename that omits it keeps it.
      const c = await adminA.post('/api/admin/courses').send({ name: 'Thumb course', thumbnail_url: up.body.url }).expect(201);
      expect(c.body.course.thumbnail_url).toBe(up.body.url);
      const ren = await adminA.put(`/api/admin/courses/${c.body.course.id}`).send({ name: 'Thumb course 2' }).expect(200);
      expect(ren.body.course.thumbnail_url).toBe(up.body.url);
      // An explicit null removes it, and drops the stored file.
      const rm = await adminA.put(`/api/admin/courses/${c.body.course.id}`).send({ name: 'Thumb course 2', thumbnail_url: null }).expect(200);
      expect(rm.body.course.thumbnail_url).toBeNull();
      expect(existsSync(file)).toBe(false);

      // The rollback route deletes an uploaded thumbnail nothing saved.
      const up2 = await adminA.post('/api/admin/media/course-thumbnail').attach('image', PNG_1X1, { filename: 'c.png', contentType: 'image/png' }).expect(200);
      const file2 = join(uploads(), 'course-thumbnails', up2.body.url.split('/').pop());
      await noUpload.delete('/api/admin/media/course-thumbnail').send({ url: up2.body.url }).expect(403);
      const del = await adminA.delete('/api/admin/media/course-thumbnail').send({ url: up2.body.url }).expect(200);
      expect(del.body).toEqual({ ok: true });
      expect(existsSync(file2)).toBe(false);
      // A path outside the thumbnails store is ignored, never unlinked.
      await adminA.delete('/api/admin/media/course-thumbnail').send({ url: '/uploads/../.env' }).expect(200);
      expect(existsSync(join(RUNTIME, '.env'))).toBe(true);
    });

    it('refuses SVG, a fake PNG, a missing file, and callers without upload_content', async () => {
      const svg = await adminA.post('/api/admin/media/course-thumbnail').attach('image', SVG, { filename: 'x.svg', contentType: 'image/svg+xml' });
      expect(svg.status).toBe(422);
      const fake = await adminA.post('/api/admin/media/course-thumbnail').attach('image', FAKE_PNG, { filename: 'x.png', contentType: 'image/png' });
      expect(fake.status).toBe(422);
      expect(fake.body.message).toMatch(/not a valid PNG/i);
      await adminA.post('/api/admin/media/course-thumbnail').expect(400);
      await noUpload.post('/api/admin/media/course-thumbnail').attach('image', PNG_1X1, { filename: 'c.png', contentType: 'image/png' }).expect(403);
      await learnerA.post('/api/admin/media/course-thumbnail').attach('image', PNG_1X1, { filename: 'c.png', contentType: 'image/png' }).expect(403);
    });

    it('stores an organization logo the same way, with the same checks', async () => {
      const up = await adminA.post('/api/admin/media/organization-logo').attach('image', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
      expect(up.status).toBe(200);
      expect(up.body).toEqual({ ok: true, url: expect.stringMatching(/^\/uploads\/course-thumbnails\/.+\.png$/) });
      expect(existsSync(join(uploads(), 'course-thumbnails', up.body.url.split('/').pop()))).toBe(true);
      await adminA.post('/api/admin/media/organization-logo').attach('image', SVG, { filename: 'l.svg', contentType: 'image/svg+xml' }).expect(422);
      await adminA.post('/api/admin/media/organization-logo').attach('image', FAKE_PNG, { filename: 'l.png', contentType: 'image/png' }).expect(422);
      await noUpload.post('/api/admin/media/organization-logo').attach('image', PNG_1X1, { filename: 'l.png', contentType: 'image/png' }).expect(403);
    });
  });

  describe('profile picture (any signed-in person)', () => {
    it('a learner uploads and removes their own picture; fakes are refused; anonymous is 401', async () => {
      const up = await learnerA.post('/api/media/avatar').attach('image', PNG_1X1, { filename: 'me.png', contentType: 'image/png' });
      expect(up.status).toBe(200);
      expect(up.body.url).toMatch(/^\/uploads\/avatars\/.+\.png$/);
      const file = join(uploads(), 'avatars', up.body.url.split('/').pop());
      expect(existsSync(file)).toBe(true);
      await learnerA.post('/api/media/avatar').attach('image', FAKE_PNG, { filename: 'me.png', contentType: 'image/png' }).expect(422);
      await learnerA.post('/api/media/avatar').attach('image', SVG, { filename: 'me.svg', contentType: 'image/svg+xml' }).expect(422);
      await anon(app).post('/api/media/avatar').attach('image', PNG_1X1, { filename: 'me.png', contentType: 'image/png' }).expect(401);
      const del = await learnerA.delete('/api/media/avatar').send({ url: up.body.url }).expect(200);
      expect(del.body).toEqual({ ok: true });
      expect(existsSync(file)).toBe(false);
      // An admin can use it too.
      await adminA.post('/api/media/avatar').attach('image', PNG_1X1, { filename: 'a.png', contentType: 'image/png' }).expect(200);
    });
  });

  describe('object storage routes (R2 absent: documented 503)', () => {
    let c: BuiltCourse;
    beforeAll(async () => { c = await buildCourse(adminA); });

    it('presigns refuse with 503 naming the missing configuration, after validating the request', async () => {
      const v = await adminA.post('/api/admin/media/video/presign').send({ filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1000 });
      expect(v.status).toBe(503);
      expect(v.body.message).toMatch(/not configured/i);
      const d = await adminA.post('/api/admin/media/document/presign').send({ filename: 'd.pdf', contentType: 'application/pdf', sizeBytes: 1000 });
      expect(d.status).toBe(503);
      // The size cap is checked before storage is touched.
      const big = await adminA.post('/api/admin/media/document/presign').send({ filename: 'd.pdf', contentType: 'application/pdf', sizeBytes: 200 * 1024 * 1024 });
      expect(big.status).toBe(422);
      await adminA.post('/api/admin/media/video/presign').send({ filename: 'v.exe', contentType: 'application/x-msdownload', sizeBytes: 1 }).expect(400);
      await noUpload.post('/api/admin/media/video/presign').send({ filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1000 }).expect(403);
      await noUpload.post('/api/admin/media/document/presign').send({ filename: 'd.pdf', contentType: 'application/pdf', sizeBytes: 1000 }).expect(403);

      const lv = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/video/presign`).send({ filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1000 });
      expect(lv.status).toBe(503);
      await adminA.post('/api/admin/lessons/999999/video/presign').send({ filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1000 }).expect(404);
      await adminB.post(`/api/admin/lessons/${c.lessonIds[0]}/video/presign`).send({ filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1000 }).expect(404);
    });

    it('confirm refuses a foreign key prefix, and an upload not in storage', async () => {
      await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/video/confirm`).send({ key: 'lessons/123456/video/x.mp4' }).expect(400);
      const r = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/video/confirm`).send({ key: `lessons/${c.lessonIds[0]}/video/x.mp4` });
      expect(r.status).toBe(422);
      const [row] = await dbQuery('SELECT video_key FROM lessons WHERE id = $1', [c.lessonIds[0]]);
      expect(row.video_key).toBeNull();
      await noUpload.post(`/api/admin/lessons/${c.lessonIds[0]}/video/confirm`).send({ key: 'lessons/incoming/x.mp4' }).expect(403);
    });

    it('captions are validated, then storing them needs R2 (503)', async () => {
      const bad = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/captions`).attach('captions', Buffer.from('just text'), { filename: 'c.srt', contentType: 'text/plain' });
      expect(bad.status).toBe(422);
      const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
      const r = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/captions`).attach('captions', srt, { filename: 'c.srt', contentType: 'text/plain' });
      expect(r.status).toBe(503);
      await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/captions`).expect(400);
      await noUpload.post(`/api/admin/lessons/${c.lessonIds[0]}/captions`).attach('captions', srt, { filename: 'c.srt', contentType: 'text/plain' }).expect(403);
    });

    it('removing a video or captions clears the column (storage delete is best-effort)', async () => {
      const id = c.lessonIds[0];
      await dbQuery("UPDATE lessons SET video_key = $2, caption_key = $3 WHERE id = $1", [id, `lessons/${id}/video/a.mp4`, `lessons/${id}/captions/a.vtt`]);
      await noUpload.delete(`/api/admin/lessons/${id}/video`).expect(403);
      await adminB.delete(`/api/admin/lessons/${id}/video`).expect(404);
      await adminA.delete(`/api/admin/lessons/${id}/video`).expect(200);
      await noUpload.delete(`/api/admin/lessons/${id}/captions`).expect(403);
      await adminA.delete(`/api/admin/lessons/${id}/captions`).expect(200);
      const [row] = await dbQuery('SELECT video_key, caption_key FROM lessons WHERE id = $1', [id]);
      expect(row).toEqual({ video_key: null, caption_key: null });
      // Nothing attached: still a clean ok.
      const again = await adminA.delete(`/api/admin/lessons/${id}/video`).expect(200);
      expect(again.body).toEqual({ ok: true });
    });

    it('the admin media view reports what a lesson has', async () => {
      const r = await adminA.get(`/api/admin/lessons/${c.lessonIds[0]}/media`).expect(200);
      expect(r.body).toEqual(expect.objectContaining({ lessonId: c.lessonIds[0], hasVideo: false, hasCaptions: false, videoUrl: null, captionUrl: null }));
      await adminB.get(`/api/admin/lessons/${c.lessonIds[0]}/media`).expect(404);
      await learnerA.get(`/api/admin/lessons/${c.lessonIds[0]}/media`).expect(403);
    });
  });

  describe('learner media', () => {
    let c: BuiltCourse;
    let me: Agent;
    let resourceId: number;

    beforeAll(async () => {
      c = await buildCourse(adminA, { lessons: 2 });
      const p = await newPerson(adminA, fx.A);
      me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const r = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/resources`).send({ title: 'Spec', source: 'link', url: 'https://e.test/spec' }).expect(201);
      resourceId = r.body.resource.id;
    });

    it('describes a lesson with no stored media, and points a document lesson at the checked route', async () => {
      const id = c.lessonIds[0];
      const r = await me.get(`/api/learner/lessons/${id}/media`).expect(200);
      expect(r.body).toEqual(expect.objectContaining({ lessonId: id, videoUrl: null, documentUrl: null, expiresIn: 0 }));

      await dbQuery("UPDATE lessons SET document_key = 'lessons/documents/incoming/x.pdf', document_name = 'x.pdf', document_mime = 'application/pdf' WHERE id = $1", [c.lessonIds[1]]);
      const d = await me.get(`/api/learner/lessons/${c.lessonIds[1]}/media`).expect(200);
      // A same-origin, cookie-checked path, never a presigned bearer URL.
      expect(d.body.documentUrl).toBe(`/api/learner/lessons/${c.lessonIds[1]}/document`);
      expect(d.body.documentName).toBe('x.pdf');
      // Streaming it needs R2: documented 503.
      const doc = await me.get(`/api/learner/lessons/${c.lessonIds[1]}/document`);
      expect(doc.status).toBe(503);
      // A lesson with no document is a 404.
      await me.get(`/api/learner/lessons/${id}/document`).expect(404);

      await learnerA.get(`/api/learner/lessons/${id}/media`).expect(403);
      await learnerA.get(`/api/learner/lessons/${c.lessonIds[1]}/document`).expect(403);
      await learnerB.get(`/api/learner/lessons/${id}/media`).expect(404);
      await adminA.get(`/api/learner/lessons/${id}/media`).expect(403);
    });

    it('records video progress, clamped to the video length, keeping the maximum', async () => {
      const id = c.lessonIds[0];
      await dbQuery('UPDATE lessons SET video_duration_seconds = 100 WHERE id = $1', [id]);
      const r = await me.post(`/api/learner/lessons/${id}/video-progress`).send({ watchedSeconds: 500, positionSeconds: 40 }).expect(200);
      expect(r.body).toEqual({ ok: true, watchedSeconds: 100 });
      await me.post(`/api/learner/lessons/${id}/video-progress`).send({ watchedSeconds: 30, positionSeconds: 30 }).expect(200);
      const [row] = await dbQuery('SELECT watched_seconds, last_position_seconds FROM lesson_video_progress WHERE lesson_id = $1', [id]);
      expect(row.watched_seconds).toBe(100);
      await me.post(`/api/learner/lessons/${id}/video-progress`).send({ watchedSeconds: -1, positionSeconds: 0 }).expect(400);
      await learnerA.post(`/api/learner/lessons/${id}/video-progress`).send({ watchedSeconds: 5, positionSeconds: 5 }).expect(403);
      await learnerB.post(`/api/learner/lessons/${id}/video-progress`).send({ watchedSeconds: 5, positionSeconds: 5 }).expect(404);
    });

    it('hands out a resource link per click, only to an enrolled learner', async () => {
      const r = await me.get(`/api/learner/resources/${resourceId}/url`).expect(200);
      expect(r.body).toEqual({ url: 'https://e.test/spec', expiresIn: 0, title: 'Spec' });
      await learnerA.get(`/api/learner/resources/${resourceId}/url`).expect(403);
      await learnerB.get(`/api/learner/resources/${resourceId}/url`).expect(404);
    });
  });
});
