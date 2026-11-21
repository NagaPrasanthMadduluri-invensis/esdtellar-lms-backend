/**
 * Commercial and platform (CONTEXT.md §14): Edstellar service requests,
 * referrals (prospect invite, first-touch, reward tiers) and billing
 * (invoices, payments, the four ledger refusals, derived states).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, signIn, uniq, type Agent } from './helpers';
import { limitedAdmin, waitFor } from './support/6';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('commercial', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let sa: Agent;
  let learnerA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    sa = await signIn(app, fx.platform.admin);
    learnerA = await signIn(app, fx.A.learner);
  });
  afterAll(async () => { await app.close(); });

  describe('service requests', () => {
    it('a tenant admin files, lists and reads a request; the platform responds and only it moves the status', async () => {
      const created = await adminA.post('/api/admin/services/requests')
        .send({ service: 'Training Needs Analysis (TNA)', answers: { goal: 'upskill' }, timeline: 'Q1', budget: '10k' }).expect(201);
      const req = created.body.request;
      expect(req).toEqual(expect.objectContaining({ service: 'Training Needs Analysis (TNA)', status: 'pending', contact_email: fx.A.admin.email, timeline: 'Q1' }));
      expect(req.ref_no).toMatch(/^REQ-\d{4}-\d{4}$/);

      const list = await adminA.get('/api/admin/services/requests').expect(200);
      expect(list.body.requests.map((r: { id: number }) => r.id)).toContain(req.id);
      expect(list.body.counts.pending).toBeGreaterThanOrEqual(1);
      expect(list.body.counts.total).toBe(list.body.requests.length);

      const one = await adminA.get(`/api/admin/services/requests/${req.id}`).expect(200);
      expect(one.body.request.answers).toEqual({ goal: 'upskill' });

      // Another tenant cannot see it; it is not in their list either.
      await adminB.get(`/api/admin/services/requests/${req.id}`).expect(404);
      const bList = await adminB.get('/api/admin/services/requests').expect(200);
      expect(bList.body.requests.map((r: { id: number }) => r.id)).not.toContain(req.id);

      // The tenant has no route that moves the status; the platform does.
      await adminA.patch(`/api/platform/service-requests/${req.id}`).send({ status: 'closed' }).expect(403);
      const pl = await sa.get('/api/platform/service-requests').expect(200);
      expect(pl.body.requests.map((r: { id: number }) => r.id)).toContain(req.id);
      const pOne = await sa.get(`/api/platform/service-requests/${req.id}`).expect(200);
      expect(pOne.body.request.organization_id).toBe(fx.A.id);
      await sa.patch(`/api/platform/service-requests/${req.id}`).send({ status: 'nonsense' }).expect(400);
      const resp = await sa.patch(`/api/platform/service-requests/${req.id}`).send({ status: 'in_discussion', response_note: 'Call booked' }).expect(200);
      expect(resp.body.request).toEqual(expect.objectContaining({ status: 'in_discussion', response_note: 'Call booked' }));

      const after = await adminA.get(`/api/admin/services/requests/${req.id}`).expect(200);
      expect(after.body.request.status).toBe('in_discussion');
      expect(after.body.request.response_note).toBe('Call booked');
      const note = await waitFor(async () => (await dbQuery(
        "SELECT user_id FROM notifications WHERE type = 'service_request_answered' AND subject_id = $1 AND user_id = $2", [req.id, fx.A.admin.id]))[0]);
      expect(note).toBeTruthy();
      await sa.get('/api/platform/service-requests/999999').expect(404);
    });

    it('refuses a service not in the catalogue, a learner, and an admin without request_services', async () => {
      await adminA.post('/api/admin/services/requests').send({ service: 'Pizza delivery' }).expect(400);
      await learnerA.get('/api/admin/services/requests').expect(403);
      const lim = await limitedAdmin(app, adminA, fx.A, ['view_dashboard']);
      await lim.agent.get('/api/admin/services/requests').expect(403);
      await lim.agent.post('/api/admin/services/requests').send({ service: 'Training Needs Analysis (TNA)' }).expect(403);
      await adminA.get('/api/platform/service-requests').expect(403);
    });
  });

  describe('referrals', () => {
    const prospect = () => `${uniq('prospect')}@prospect.e2e.test`;
    const refer = (agent: Agent, email: string) =>
      agent.post('/api/admin/referrals').send({ company_name: uniq('Co'), contact_name: 'Pat Prospect', contact_email: email });

    it('creates a referral, emails the prospect as a direct outbox row with no user, and tells the platform', async () => {
      const email = prospect();
      const r = await refer(adminA, email).expect(201);
      const ref = r.body.referral;
      expect(ref.ref_no).toMatch(/^REF-\d{4}-\d{4}$/);
      expect(ref).toEqual(expect.objectContaining({ status: 'invited', contact_email: email, referrer_email: fx.A.admin.email }));

      const row = await waitFor(async () => (await dbQuery(
        'SELECT user_id, type, to_email, organization_id, status FROM email_outbox WHERE to_email = $1', [email]))[0]);
      expect(row).toEqual(expect.objectContaining({ user_id: null, type: 'referral_invite', organization_id: fx.A.id, status: 'pending' }));

      const platformNote = await waitFor(async () => (await dbQuery(
        "SELECT user_id FROM notifications WHERE type = 'referral_received' AND subject_id = $1 AND user_id = $2", [ref.id, fx.platform.admin.id]))[0]);
      expect(platformNote).toBeTruthy();

      const one = await adminA.get(`/api/admin/referrals/${ref.id}`).expect(200);
      expect(one.body.referral.id).toBe(ref.id);
      await adminB.get(`/api/admin/referrals/${ref.id}`).expect(404);
    });

    it('a prospect email is first-touch: the same address from another org is a 409, whatever its case', async () => {
      const email = prospect();
      await refer(adminA, email).expect(201);
      await refer(adminB, email.toUpperCase()).expect(409);
      await refer(adminA, email).expect(409);
    });

    it('converting tells the referrer once, and the reward tier is 15% at 2 and 25% at 3 conversions', async () => {
      const start = await adminA.get('/api/admin/referrals').expect(200);
      expect(start.body.reward).toEqual(expect.objectContaining({ convertedCount: 0, discountPct: 0, nextTierAt: 2, nextDiscountPct: 15 }));

      const ids: number[] = [];
      for (let i = 0; i < 3; i++) ids.push((await refer(adminA, prospect()).expect(201)).body.referral.id);

      const expected = [
        { convertedCount: 1, discountPct: 0, nextTierAt: 2, toNext: 1 },
        { convertedCount: 2, discountPct: 15, nextTierAt: 3, nextDiscountPct: 25 },
        { convertedCount: 3, discountPct: 25, nextTierAt: null, toNext: 0 },
      ];
      for (const [i, id] of ids.entries()) {
        const p = await sa.patch(`/api/platform/referrals/${id}`).send({ status: 'converted', platform_note: 'Signed', converted_organization_id: fx.B.id }).expect(200);
        expect(p.body.referral).toEqual(expect.objectContaining({ status: 'converted', converted_organization_id: fx.B.id }));
        expect(p.body.referral.converted_at).toBeTruthy();
        const list = await adminA.get('/api/admin/referrals').expect(200);
        expect(list.body.reward).toEqual(expect.objectContaining(expected[i]));
        expect(list.body.counts.converted).toBe(i + 1);
      }

      const notes = await waitFor(async () => {
        const x = await dbQuery("SELECT subject_id FROM notifications WHERE type = 'referral_converted' AND user_id = $1 AND subject_id = ANY($2)", [fx.A.admin.id, ids]);
        return x.length === 3 ? x : null;
      });
      expect(notes).toHaveLength(3);

      // Re-saving a converted referral does not ring the bell again.
      await sa.patch(`/api/platform/referrals/${ids[0]}`).send({ status: 'converted' }).expect(200);
      await new Promise((r) => setTimeout(r, 300));
      const again = await dbQuery("SELECT id FROM notifications WHERE type = 'referral_converted' AND subject_id = $1", [ids[0]]);
      expect(again).toHaveLength(1);

      // Org B's reward is untouched by org A's conversions.
      const b = await adminB.get('/api/admin/referrals').expect(200);
      expect(b.body.reward.convertedCount).toBe(0);
    });

    it('the platform queue lists every org, reads one, and refuses a bad status or organization', async () => {
      const ref = (await refer(adminB, prospect()).expect(201)).body.referral;
      const all = await sa.get('/api/platform/referrals').expect(200);
      const orgs = new Set(all.body.referrals.map((r: { organization_id: number }) => r.organization_id));
      expect(orgs.has(fx.A.id) && orgs.has(fx.B.id)).toBe(true);
      const onlyB = await sa.get('/api/platform/referrals').query({ organization_id: fx.B.id }).expect(200);
      for (const r of onlyB.body.referrals) expect(r.organization_id).toBe(fx.B.id);
      const one = await sa.get(`/api/platform/referrals/${ref.id}`).expect(200);
      expect(one.body.referral.company_name).toBe(ref.company_name);
      await sa.patch(`/api/platform/referrals/${ref.id}`).send({ status: 'won' }).expect(400);
      await sa.patch(`/api/platform/referrals/${ref.id}`).send({ status: 'converted', converted_organization_id: 999999 }).expect(400);
      const contacted = await sa.patch(`/api/platform/referrals/${ref.id}`).send({ status: 'contacted' }).expect(200);
      expect(contacted.body.referral.status).toBe('contacted');
      await sa.get('/api/platform/referrals/999999').expect(404);
    });

    it('refuses a learner, an admin without manage_referrals, and a tenant admin on the platform queue', async () => {
      await learnerA.post('/api/admin/referrals').send({ company_name: 'X', contact_name: 'Y', contact_email: prospect() }).expect(403);
      const lim = await limitedAdmin(app, adminA, fx.A, ['view_dashboard']);
      await lim.agent.get('/api/admin/referrals').expect(403);
      await adminA.get('/api/platform/referrals').expect(403);
      await adminA.patch('/api/platform/referrals/1').send({ status: 'converted' }).expect(403);
      await adminA.post('/api/admin/referrals').send({ company_name: 'X', contact_name: 'Y', contact_email: 'not-an-email' }).expect(400);
    });
  });

  describe('billing', () => {
    const create = (body: Record<string, unknown>) =>
      sa.post('/api/platform/billing/invoices').send({ organization_id: fx.A.id, issue_date: day(-1), due_date: day(30), amount: 1000, ...body });

    it('creates, reads, lists and edits an invoice; payments move the derived state', async () => {
      const c = await create({ status: 'issued', description: uniq('inv') }).expect(201);
      const inv = c.body.invoice;
      expect(inv).toEqual(expect.objectContaining({ organization_id: fx.A.id, amount: 1000, paid: 0, outstanding: 1000, status: 'issued', state: 'issued' }));
      expect(inv.invoice_no).toBeTruthy();

      const list = await sa.get('/api/platform/billing/invoices').query({ organization_id: fx.A.id }).expect(200);
      expect(list.body.invoices.map((i: { id: number }) => i.id)).toContain(inv.id);
      for (const i of list.body.invoices) expect(i.organization_id).toBe(fx.A.id);
      expect(list.body.totals).toEqual(expect.objectContaining({ invoiced: expect.any(Number), collected: expect.any(Number) }));

      const paid = await sa.post(`/api/platform/billing/invoices/${inv.id}/payments`).send({ amount: 400, paid_on: day(0), method: 'bank_transfer', reference: 'TX1' }).expect(201);
      expect(paid.body.invoice).toEqual(expect.objectContaining({ paid: 400, outstanding: 600, state: 'part_paid', payment_count: 1 }));
      expect(paid.body.payments).toHaveLength(1);
      const paymentId = paid.body.payments[0].id;

      const got = await sa.get(`/api/platform/billing/invoices/${inv.id}`).expect(200);
      expect(got.body.payments[0]).toEqual(expect.objectContaining({ amount: 400, reference: 'TX1' }));

      // Raising the amount is fine; the outstanding follows.
      const up = await sa.patch(`/api/platform/billing/invoices/${inv.id}`).send({ amount: 1200, notes: 'raised' }).expect(200);
      expect(up.body.invoice).toEqual(expect.objectContaining({ amount: 1200, outstanding: 800, notes: 'raised' }));

      // Paying the rest makes it paid.
      const full = await sa.post(`/api/platform/billing/invoices/${inv.id}/payments`).send({ amount: 800, paid_on: day(0) }).expect(201);
      expect(full.body.invoice).toEqual(expect.objectContaining({ state: 'paid', outstanding: 0 }));

      // Removing a payment reopens it.
      const un = await sa.delete(`/api/platform/billing/invoices/${inv.id}/payments/${paymentId}`).expect(200);
      expect(un.body.invoice).toEqual(expect.objectContaining({ paid: 800, state: 'part_paid' }));
      await sa.delete(`/api/platform/billing/invoices/${inv.id}/payments/${paymentId}`).expect(404);
    });

    it('refuses an overpayment, lowering below paid, deleting with payments, and a due date before issue', async () => {
      const inv = (await create({ status: 'issued' }).expect(201)).body.invoice;
      await sa.post(`/api/platform/billing/invoices/${inv.id}/payments`).send({ amount: 300, paid_on: day(0) }).expect(201);

      await sa.post(`/api/platform/billing/invoices/${inv.id}/payments`).send({ amount: 701, paid_on: day(0) }).expect(422);
      await sa.patch(`/api/platform/billing/invoices/${inv.id}`).send({ amount: 299 }).expect(422);
      await sa.delete(`/api/platform/billing/invoices/${inv.id}`).expect(422);
      await sa.patch(`/api/platform/billing/invoices/${inv.id}`).send({ due_date: day(-5) }).expect(422);
      await create({ issue_date: day(0), due_date: day(-1) }).expect(422);

      // Nothing changed.
      const [row] = await dbQuery('SELECT amount::float AS amount, due_date::text AS due FROM invoices WHERE id = $1', [inv.id]);
      expect(row.amount).toBe(1000);
      expect(row.due).toBe(day(30));
      const [{ n }] = await dbQuery<{ n: number }>('SELECT COUNT(*)::int AS n FROM invoice_payments WHERE invoice_id = $1', [inv.id]);
      expect(n).toBe(1);
    });

    it('derives draft, overdue and void; a draft or void invoice takes no payment; an unpaid one can be deleted', async () => {
      const draft = (await create({}).expect(201)).body.invoice;
      expect(draft.state).toBe('draft');
      await sa.post(`/api/platform/billing/invoices/${draft.id}/payments`).send({ amount: 10, paid_on: day(0) }).expect(422);

      const overdue = (await create({ status: 'issued', issue_date: day(-60), due_date: day(-30) }).expect(201)).body.invoice;
      expect(overdue.state).toBe('overdue');

      const voided = await sa.patch(`/api/platform/billing/invoices/${overdue.id}`).send({ status: 'void' }).expect(200);
      expect(voided.body.invoice.state).toBe('void');
      await sa.post(`/api/platform/billing/invoices/${overdue.id}/payments`).send({ amount: 10, paid_on: day(0) }).expect(422);

      const del = await sa.delete(`/api/platform/billing/invoices/${draft.id}`).expect(200);
      expect(del.body.message).toMatch(/deleted/i);
      await sa.get(`/api/platform/billing/invoices/${draft.id}`).expect(404);
      await sa.post('/api/platform/billing/invoices').send({ organization_id: fx.A.id, issue_date: day(0), due_date: day(1), amount: -5 }).expect(400);
    });

    it('is platform-only', async () => {
      await adminA.get('/api/platform/billing/invoices').expect(403);
      await adminA.post('/api/platform/billing/invoices').send({ organization_id: fx.A.id, issue_date: day(0), due_date: day(1), amount: 1 }).expect(403);
      await learnerA.get('/api/platform/billing/invoices').expect(403);
    });
  });
});
