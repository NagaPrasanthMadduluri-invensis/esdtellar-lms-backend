import { courseFunctions, jobFunctionOf, rankForRole, roleFit } from './job-role-fit';

// The real job roles and catalogue of the demo organization (2026-11-24).
const CATALOGUE = [
  { name: 'Sales Prospecting and Closing', category: 'Soft Skills', tags: 'sales, crm' },
  { name: 'Secure Coding for Developers', category: 'Technical', skills: ['Software development'] },
  { name: 'Diversity, Equity and Inclusion', category: 'HR' },
  { name: 'Supply Chain Operations 101', category: 'Operations' },
  { name: 'Financial Fundamentals for Managers', category: 'Finance' },
  { name: 'Data Privacy and PDPA Awareness', category: 'Compliance' },
  { name: 'Leading High-Performing Teams', category: 'Leadership' },
  { name: 'Cloud Computing Basics', category: 'Technical' },
  { name: 'Data Visualisation Fundamentals', category: 'Technical' },
  { name: 'Introduction to Python for Analysts', category: 'Technical' },
  { name: 'Effective Communication at Work', category: 'Soft Skills' },
  { name: 'Consultative Selling', category: 'Technical', skills: ['Negotiation'] },
];
const names = (fn: ReturnType<typeof jobFunctionOf>) => rankForRole(CATALOGUE, fn).map((c) => c.name);

describe('jobFunctionOf', () => {
  it.each([
    ['Software engineer', 'engineering'],
    ['Senior Software Engineer', 'engineering'],
    ['Web Developer', 'engineering'],
    ['Data Analyst', 'data'],
    ['Operations Analyst', 'operations'],
    ['Sales Executive', 'sales'],
    ['SEO Analyst', 'marketing'],
    ['Marketing manager', 'marketing'],
    ['HR Associate', 'hr'],
    ['Finance Associate', 'finance'],
    ['UI/UX Designer', 'design'],
    ['Video graphic designer', 'design'],
    ['Sales Engineer', 'sales'],
  ])('%s -> %s', (role, fn) => {
    expect(jobFunctionOf(role)).toBe(fn);
  });

  it('falls back to the department, and is null when nothing says anything', () => {
    expect(jobFunctionOf('Associate', 'Finance')).toBe('finance');
    expect(jobFunctionOf(null, null)).toBeNull();
    expect(jobFunctionOf('Associate', 'General')).toBeNull();
  });
});

describe('courseFunctions', () => {
  it('universal categories and audience-wide titles are for everyone', () => {
    expect(courseFunctions({ name: 'Data Privacy and PDPA Awareness', category: 'Compliance' })).toEqual([]);
    expect(courseFunctions({ name: 'Financial Fundamentals for Managers', category: 'Finance' })).toEqual([]);
    expect(courseFunctions({ name: 'Diversity, Equity and Inclusion', category: 'HR' })).toEqual([]);
  });

  it('reads the function from words, tags, skills and a functional category', () => {
    expect(courseFunctions({ name: 'Consultative Selling', category: 'Technical', skills: ['Negotiation'] })).toEqual(['sales']);
    expect(courseFunctions({ name: 'Supply Chain Operations 101', category: 'Operations' })).toEqual(['operations']);
    expect(courseFunctions({ name: 'Introduction to Python for Analysts', category: 'Technical' })).toEqual(['engineering', 'data']);
  });
});

describe('rankForRole', () => {
  it('a software engineer is never offered a sales course; role courses come first', () => {
    const list = names(jobFunctionOf('Software engineer'));
    expect(list).not.toContain('Sales Prospecting and Closing');
    expect(list).not.toContain('Consultative Selling');
    expect(list).not.toContain('Supply Chain Operations 101');
    expect(list.slice(0, 3)).toEqual(['Secure Coding for Developers', 'Cloud Computing Basics', 'Introduction to Python for Analysts']);
    expect(list).toContain('Data Privacy and PDPA Awareness');
    expect(list).toContain('Effective Communication at Work');
  });

  it('a sales executive gets the sales courses first and no engineering course', () => {
    const ranked = rankForRole(CATALOGUE, jobFunctionOf('Sales Executive'));
    expect(ranked.slice(0, 2).map((c) => [c.name, c.roleFit])).toEqual([
      ['Sales Prospecting and Closing', 'role'],
      ['Consultative Selling', 'role'],
    ]);
    const list = ranked.map((c) => c.name);
    expect(list).not.toContain('Secure Coding for Developers');
    expect(list).not.toContain('Cloud Computing Basics');
  });

  it('a data analyst sees engineering courses as related, after data ones', () => {
    const ranked = rankForRole(CATALOGUE, 'data');
    expect(ranked.find((c) => c.name === 'Cloud Computing Basics')?.roleFit).toBe('related');
    expect(ranked[0].roleFit).toBe('role');
  });

  it('an unreadable role filters nothing', () => {
    expect(rankForRole(CATALOGUE, null)).toHaveLength(CATALOGUE.length);
    expect(roleFit(['sales'], null)).toBe('general');
  });
});
