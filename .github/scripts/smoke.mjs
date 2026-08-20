/**
 * Run the built CLI against the machine it is running on.
 *
 *   node .github/scripts/smoke.mjs
 *
 * The unit tests read recorded fixtures, which is what makes Linux parsing
 * testable on Windows. It also means a collector can stop working on a
 * platform nobody develops on and every test still passes. This runs the real
 * thing on the real machine, which is the only check that would notice.
 *
 * Written in Node rather than in the workflow, because the workflow's shell is
 * pwsh on Windows and bash everywhere else, and an exit code assertion spelled
 * two ways is an exit code assertion nobody trusts.
 */
import { spawnSync } from 'node:child_process';
import { platform } from 'node:process';

const CLI = 'dist/cli.js';
let failures = 0;

const run = (args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
};

const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => `        ${l}`).join('\n'));
  }
};

console.log(`whotop smoke test on ${platform}`);

// The listing has to be readable, and it has to have found this very process.
const listing = run(['ls', '--json', '--all']);
check('ls --json --all exits 0', listing.code === 0, listing.err);

let snapshot = null;
try {
  snapshot = JSON.parse(listing.out);
} catch (error) {
  check('ls --json emits parseable JSON', false, error.message);
}

if (snapshot) {
  check('the snapshot names its platform', snapshot.platform === platform, `got ${snapshot.platform}`);
  check('the snapshot has a capture time', typeof snapshot.capturedAt === 'string');
  check('the process table is not empty', Array.isArray(snapshot.processes) && snapshot.processes.length > 0);

  // A collector that returned rows but filled none of them in is the failure
  // this exists to catch, and it is not one an empty check would see.
  const named = (snapshot.processes ?? []).filter((p) => typeof p.name === 'string' && p.name !== '');
  check(
    'every process has a pid and a name',
    named.length === snapshot.processes.length && snapshot.processes.every((p) => Number.isInteger(p.pid)),
    `${named.length} of ${snapshot.processes.length} named`,
  );

  // The runner is a node process running this script, so at least one node
  // process must be in there. If it is not, the collector missed the machine
  // it was standing on.
  const anyNode = (snapshot.processes ?? []).some((p) => /node/i.test(p.name ?? ''));
  check('the collector can see node itself', anyNode);

  // Warnings are expected on a CI runner (no elevation, sparse socket tables).
  // They are printed rather than failed on, so a change in what a platform
  // withholds is visible in the log without breaking the build.
  for (const warning of snapshot.warnings ?? []) console.log(`  note  ${warning}`);
}

// Every other entry point, with the exit code each one documents.
const cases = [
  { args: ['version'], code: 0 },
  { args: ['--help'], code: 0 },
  { args: ['ls', '--explain'], code: 0 },
  { args: ['ls', '--role', 'dev-server'], code: 0 },
  // 65535 is reserved and nothing listens on it, which is exit 1: no match.
  { args: ['port', '65535'], code: 1 },
  // An argument that does not exist is a usage error, not a crash.
  { args: ['--no-such-flag'], code: 2 },
];

for (const { args, code } of cases) {
  const result = run(args);
  check(`whotop ${args.join(' ')} exits ${code}`, result.code === code, `exit ${result.code}\n${result.err}`);
}

// A pipe gets the listing rather than the interactive screen, which is what
// keeps whotop | grep vite working. stdin here is not a terminal.
const piped = run([]);
check('a pipe gets the listing, not the screen', piped.code === 0 && piped.out.length > 0, piped.err);

console.log(failures === 0 ? '\nall good' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
