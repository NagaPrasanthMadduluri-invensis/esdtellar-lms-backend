import {
  TENANT_ISOLATION_DIRECTIVE,
  assertSameTenant,
  fenceSystemPrompt,
  tenantTag,
} from './ai-tenant';

const scope = (organizationId: number) =>
  ({ organizationId, platformOrganizationId: 1 }) as any;

describe('AI tenant fence', () => {
  it('passes when the context org matches the scope', () => {
    expect(() => assertSameTenant(scope(7), 7)).not.toThrow();
  });

  it('THROWS when a context from another tenant reaches the scope', () => {
    // The one thing that must never happen: org 7's prompt carrying org 11's data.
    expect(() => assertSameTenant(scope(7), 11)).toThrow(/tenant fence violated/i);
  });

  it('fences a system prompt with the single-tenant directive', () => {
    const fenced = fenceSystemPrompt('Be a helpful coach.');
    expect(fenced.startsWith(TENANT_ISOLATION_DIRECTIVE)).toBe(true);
    expect(fenced).toContain('Be a helpful coach.');
    expect(TENANT_ISOLATION_DIRECTIVE.toLowerCase()).toContain('one organization');
  });

  it('tags a log line with the tenant, no PII', () => {
    expect(tenantTag(scope(7), 'learner=10')).toBe('org=7 learner=10');
  });
});
