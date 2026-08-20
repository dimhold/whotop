/**
 * Refuse to publish when the tag and package.json disagree.
 *
 *   node .github/scripts/check-version.mjs v0.3.0
 *
 * npm publish cannot be undone after seventy-two hours, and a tag that says
 * one thing while package.json says another puts a version on the registry
 * that no commit corresponds to. Cheap to check, impossible to reverse.
 */
import { readFileSync } from 'node:fs';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: check-version.mjs <tag>');
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const expected = `v${version}`;

if (tag !== expected) {
  console.error(`the tag is ${tag} but package.json says ${version}, so the tag should be ${expected}`);
  process.exit(1);
}

console.log(`${tag} matches package.json`);
