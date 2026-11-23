/**
 * The route parser: every route the server registers, with its guards, read
 * from the controllers. It lives in the server repo so the API e2e route
 * coverage (route-coverage.mjs) works in the server's own CI, which has no
 * workspace checkout. The workspace project map (harness/codemap.mjs)
 * imports it from here, so there is exactly one parser.
 */
import fs from 'node:fs';

/** Routes with guards, per controller class (handles several classes per file). */
export function parseRoutes(file) {
  // Whole-line // comments are dropped first: one sitting between two
  // decorators (e.g. above a multi-line @RateLimit) would otherwise break the
  // decorator chain, and a @Public() above it was lost (login read as signed-in).
  const s = fs.readFileSync(file, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
  const routes = [];
  const parts = s.split(/(?=^@Controller\()/m);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const base = (part.match(/^@Controller\(\s*(?:['"]([^'"]*)['"])?/) || [])[1] || '';
    const ci = part.indexOf('export class');
    const head = part.slice(0, ci === -1 ? 0 : ci);
    const prevTail = parts[i - 1].slice(-400);
    const clsDecos = (prevTail.match(/^@[A-Za-z]+\([^\n]*\)\s*$/gm) || []).join(' ') + ' ' + head;
    const cls = guards(clsDecos);
    const body = ci === -1 ? '' : part.slice(ci);
    const re = /((?:\s*@[A-Za-z]+\((?:[^()]|\([^()]*\))*\)\s*)+)\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(body))) {
      const decs = m[1];
      const hm = decs.match(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"])?/);
      if (!hm) continue;
      const p = '/api/' + [base, hm[2] || ''].filter(Boolean).join('/');
      const g = guards(decs);
      routes.push({ method: hm[1].toUpperCase(), path: p, guard: mergeGuards(cls, g) });
    }
  }
  return routes;
}
function guards(text) {
  const g = {};
  if (/@Public\(/.test(text)) g.public = true;
  if (/@PlatformAdmin\(/.test(text)) g.platform = true;
  const r = text.match(/@Roles\(([^)]*)\)/);
  if (r) g.roles = r[1].replace(/['"\s]/g, '');
  const p = text.match(/@Permissions\(([^)]*)\)/);
  if (p) g.perm = p[1].replace(/['"\s]/g, '');
  if (/@RateLimit\(/.test(text)) g.rl = true;
  return g;
}
function mergeGuards(a, b) {
  const g = { ...a, ...b };
  const parts = [];
  if (g.public) parts.push('public');
  if (g.platform) parts.push('platform');
  if (g.roles) parts.push(g.roles);
  if (g.perm) parts.push(g.perm);
  if (g.rl) parts.push('RL');
  return parts.join(' ') || 'signed-in';
}

