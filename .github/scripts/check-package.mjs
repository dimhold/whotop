/**
 * Assert what npm would actually publish.
 *
 *   node .github/scripts/check-package.mjs
 *
 * The package is meant to be dist, README, LICENSE and package.json. It once
 * shipped 42 source maps naming a src directory it does not contain, which is
 * the kind of thing nobody notices because nobody looks in a tarball. So this
 * looks, on every push.
 */
import { spawnSync } from 'node:child_process';

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/.+\.js$/,
  /^dist\/.+\.d\.ts$/,
];

/** Things that have shipped by accident before, or would be a mistake to ship. */
const FORBIDDEN = [
  { pattern: /\.map$/, why: 'source maps point at a src directory the package does not contain' },
  { pattern: /^src\//, why: 'the sources are in the repository, not the package' },
  { pattern: /^test\//, why: 'tests and fixtures are not for consumers' },
  { pattern: /^\.github\//, why: 'repository plumbing is not part of the package' },
  { pattern: /^assets\//, why: 'the README on npm links the picture, it does not ship it' },
  { pattern: /\.tsbuildinfo$/, why: 'a build cache is not an artefact' },
  { pattern: /^(CONTRIBUTING|CHANGELOG|SECURITY|CODE_OF_CONDUCT)\.md$/, why: 'these belong to the repository' },
];

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}

// Windows reports the paths with backslashes; the allow list is written the
// one way, so they are converted rather than matched twice.
const toPosix = (path) => path.split(String.fromCharCode(92)).join(String.fromCharCode(47));

const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((f) => toPosix(f.path));

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

for (const file of files) {
  const forbidden = FORBIDDEN.find((rule) => rule.pattern.test(file));
  if (forbidden) fail(`${file} must not ship: ${forbidden.why}`);
  else if (!ALLOWED.some((rule) => rule.test(file))) fail(`${file} is not on the allowed list`);
}

// The three files that make the package usable and lawful.
for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts']) {
  if (!files.includes(required)) fail(`${required} is missing from the package`);
}

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
console.log(`  ${files.length} files, ${kb(pack.size)} packed, ${kb(pack.unpackedSize)} unpacked`);

// Not a limit anyone imposed, a tripwire. This package has no dependencies and
// no assets; if it ever crosses this, something is being shipped by accident.
if (pack.unpackedSize > 500_000) fail(`unpacked size ${kb(pack.unpackedSize)} is larger than this package has any reason to be`);

console.log(failures === 0 ? '  ok    nothing unexpected ships' : `\n${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
