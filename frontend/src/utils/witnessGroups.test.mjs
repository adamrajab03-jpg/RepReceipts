// Grouping rules for the public witness section. Run:
//   cd frontend && node --test src/utils/witnessGroups.test.mjs
//
// The util is TypeScript, so this bundles it with the esbuild that ships inside
// vite and imports the result — no test runner or build step of its own.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const { outputFiles } = await build({
  entryPoints: [path.join(here, 'witnessGroups.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const { groupWitnesses, shouldGroupWitnesses } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

// A witness as the API delivers them. `rec: false` = detected in the transcript
// with no admin record yet.
const w = (name, { org = null, industry = null, label = null, title = null, rec = true, turns = 1 } = {}) => ({
  name, title, organization: org,
  industry, industry_custom: null, industry_label: label,
  turn_count: turns, first_seq: turns ? 1 : null, has_record: rec,
});

test('no records → the section is suppressed entirely', () => {
  const ws = [w('Sean Davis', { rec: false }), w('Gene Kimmelman', { rec: false })];
  assert.equal(shouldGroupWitnesses(ws), false);
});

test('a record without an industry does not on its own open the section', () => {
  assert.equal(shouldGroupWitnesses([w('Sean Davis', { rec: true, industry: null })]), false);
});

test('industries sort in canonical vocabulary order, not alphabetically', () => {
  const groups = groupWitnesses([
    w('Volokh',    { industry: 'academia_legal', label: 'Academia / Legal', org: 'UCLA' }),
    w('Davis',     { industry: 'media',          label: 'Media',            org: 'The Federalist' }),
    w('Treasurer', { industry: 'finance',        label: 'Finance',          org: 'A Bank' }),
  ]);
  // Media (0) < Academia/Legal (2) < Finance (5) — alphabetical would differ.
  assert.deepEqual(groups.map((g) => g.label), ['Media', 'Academia / Legal', 'Finance']);
});

test('the PoC hearing produces the expected tree', () => {
  const groups = groupWitnesses([
    w('Sean Davis',     { industry: 'media', label: 'Media', org: 'The Federalist',    title: 'CEO & Cofounder' }),
    w('Gene Kimmelman', { industry: 'media', label: 'Media', org: 'Public Knowledge',  title: 'President & CEO' }),
    w('Eugene Volokh',  { industry: 'academia_legal', label: 'Academia / Legal', org: 'UCLA School of Law', title: 'Professor of Law' }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.orgs.map((o) => [o.org, o.witnesses.map((x) => x.name)])]),
    [
      ['Media', [['The Federalist', ['Sean Davis']], ['Public Knowledge', ['Gene Kimmelman']]]],
      ['Academia / Legal', [['UCLA School of Law', ['Eugene Volokh']]]],
    ],
  );
});

test('two witnesses from one organization share one org group', () => {
  const [media] = groupWitnesses([
    w('Sean Davis',   { industry: 'media', label: 'Media', org: 'The Federalist' }),
    w('Joy Pullmann', { industry: 'media', label: 'Media', org: 'The Federalist' }),
  ]);
  assert.equal(media.orgs.length, 1);
  assert.deepEqual(media.orgs[0].witnesses.map((x) => x.name), ['Sean Davis', 'Joy Pullmann']);
});

test('organizations bucket case-insensitively but keep the first spelling', () => {
  const [media] = groupWitnesses([
    w('A', { industry: 'media', label: 'Media', org: 'The Federalist' }),
    w('B', { industry: 'media', label: 'Media', org: 'the federalist' }),
  ]);
  assert.equal(media.orgs.length, 1);
  assert.equal(media.orgs[0].org, 'The Federalist');
});

test('custom industry labels merge case-insensitively under one heading', () => {
  const groups = groupWitnesses([
    w('A', { industry: 'other', label: 'Crypto', org: 'X' }),
    w('B', { industry: 'other', label: 'crypto', org: 'Y' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Crypto');
});

test('a witness with no organization gets an unlabelled bucket, sorted last', () => {
  const [media] = groupWitnesses([
    w('Nobody',     { industry: 'media', label: 'Media', org: null }),
    w('Sean Davis', { industry: 'media', label: 'Media', org: 'The Federalist' }),
  ]);
  assert.deepEqual(media.orgs.map((o) => o.org), ['The Federalist', null]);
});

test('an un-entered witness trails in "Also spoke" rather than being filed as Other', () => {
  const groups = groupWitnesses([
    w('Unknown Person', { rec: false }),
    w('Sean Davis', { industry: 'media', label: 'Media', org: 'The Federalist' }),
    w('A Lobbyist', { industry: 'other', label: 'Other', org: 'Assoc' }),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['Media', 'Other', 'Also spoke']);
  // Critically: NOT merged into the real 'Other' group.
  assert.deepEqual(groups[1].orgs[0].witnesses.map((x) => x.name), ['A Lobbyist']);
  assert.deepEqual(groups[2].orgs[0].witnesses.map((x) => x.name), ['Unknown Person']);
});
