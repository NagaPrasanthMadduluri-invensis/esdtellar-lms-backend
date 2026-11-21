#!/usr/bin/env node
/**
 * Route-coverage gate for the API e2e suite.
 *
 * Every route the server registers (parsed from the controllers, the same
 * parser PROJECT_MAP uses) must be exercised SUCCESSFULLY by at least one e2e
 * test: a recorded request that matched the route and answered < 400. A route
 * whose only meaningful answer is an error (e.g. the retired register route)
 * is listed in route-coverage.allow.json with the reason.
 *
 * Writes test/.coverage/report.json. Exit code: 1 when anything is uncovered
 * and --strict is passed (CI), else 0 with a warning (local runs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoutes } from '../../harness/codemap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, '..', 'src', 'modules');
const strict = process.argv.includes('--strict');

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const routes = walk(MODULES).filter((f) => f.endsWith('.controller.ts')).flatMap(parseRoutes).map((r) => `${r.method} ${r.path.replace(/\/$/, '')}`);
const unique = [...new Set(routes)];

const COV = process.env.E2E_COVERAGE_DIR ? path.resolve(HERE, '..', process.env.E2E_COVERAGE_DIR) : path.join(HERE, '.coverage');
const hitsFile = path.join(COV, 'hits.jsonl');
const hits = fs.existsSync(hitsFile) ? fs.readFileSync(hitsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const ok = new Set(hits.filter((h) => h.s < 400).map((h) => `${h.m} ${h.p.replace(/\/$/, '')}`));
const touched = new Set(hits.map((h) => `${h.m} ${h.p.replace(/\/$/, '')}`));
const allowFile = path.join(HERE, 'route-coverage.allow.json');
const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : {};

const covered = unique.filter((r) => ok.has(r) || allow[r]);
const uncovered = unique.filter((r) => !ok.has(r) && !allow[r]);
const report = { total: unique.length, covered: covered.length, uncovered, onlyErrors: uncovered.filter((r) => touched.has(r)) };
fs.mkdirSync(COV, { recursive: true });
fs.writeFileSync(path.join(COV, 'report.json'), JSON.stringify(report, null, 1));

console.log(`\nRoute coverage: ${report.covered}/${report.total} routes exercised successfully by the e2e suite.`);
if (uncovered.length) {
  console.log(`${uncovered.length} route(s) have no successful e2e test${report.onlyErrors.length ? ` (${report.onlyErrors.length} only ever answered with an error)` : ''}:`);
  for (const r of uncovered.slice(0, 400)) console.log(`  - ${r}${touched.has(r) ? '  (only errors)' : ''}`);
  if (strict) {
    console.log('\nFAIL: every route needs an e2e test (see TESTING.md). Add one, or list the route in test/route-coverage.allow.json with a reason.');
    process.exit(1);
  }
  console.log('\nWARN: missing route tests (local runs only warn; CI fails on this).');
}
