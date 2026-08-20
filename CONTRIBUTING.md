# Contributing to whotop

whotop answers one question: what is this process, and which port is it
holding. Anything that makes that answer more certain, or that makes an
uncertain answer say so, belongs here.

## Getting set up

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm test              # vitest, 362 tests
npm run coverage      # the same, with a report and a floor
npm run build         # emit dist/
```

Then, on the platform you changed:

```bash
node .github/scripts/smoke.mjs
```

That one runs the built CLI against your actual machine. The unit tests read
recorded fixtures, which is what makes Linux parsing testable on Windows; it
also means a collector can stop working on a platform nobody develops on while
every test still passes. CI runs the smoke test on all three.

## What the code is trying to be

A few rules run through the whole codebase. They are worth knowing before a
review points at them.

**Nothing is claimed that was not read.** Every uncertain value is a `Field`
carrying its own provenance: `exact` when the operating system said it,
`inferred` with a note explaining the reasoning, `unavailable` with the reason
it could not be answered. A guess presented as a fact is the failure this tool
exists to prevent, because there is a kill key next to every row.

**Parsing is separate from spawning.** The collectors run a command; the
parsers under `src/collectors/parse/` turn its output into data and touch
nothing else. That split is why a Linux parser can be tested on Windows, and
why a fixture is worth more than a mock.

**Comments say why, not what.** The code says what it does. The comments carry
the reasoning that is not recoverable from reading it: which alternative was
tried, what went wrong, why the obvious approach is the wrong one. If a
comment would be obvious from the line below it, it is not needed.

**The pure part is tested; the terminal-owning part is thin.** In `src/tui.ts`
and `src/splash.ts` everything above the function that takes a terminal is
pure and takes no terminal, and that is where most of the tests live. The part
that does own a terminal is tested too, against a fake one: `test/tui-run.test.ts`
hands `runTui` a stream pair that behaves the way Node's does, and nothing
inside `runTui` is stubbed.

**What cannot be tested is injected, and nothing else is.** `main` takes an
`inspect` and a `runTui`; the Windows collector takes the function that starts
a shell; `runTui` takes a collect, a clock and a way out. Each seam exists
because the thing behind it reads a real machine or takes a real terminal, and
everything between the seams is the real code.

There is no linter. Strict `tsc` with `noUncheckedIndexedAccess` plus the test
suite covers what a linter would catch here, and adding one would put a large
dependency tree next to a package that advertises having none. If you find
yourself wanting one, open an issue rather than a pull request.

## Adding a rule

Roles come from a table in `src/classify.ts` matched against the command line.
A new tool is a token and a test. Trace sources, which name a process by the
dated directory it wrote at startup, are a row in the table in `src/traces.ts`
plus a fixture.

Only rules that were watched working on a real machine go in. A rule reasoned
out in the abstract produces confident rows out of nothing, which is worse than
`unknown`.

## Adding a parser fixture

Capture the real thing:

```bash
ss -tulnpH                        > test/fixtures/linux-ss-tulnpH.txt
lsof -nP -i -FpPn                 > test/fixtures/darwin-lsof-ports.txt
```

Remove anything you would rather not publish, keeping the shape intact, and
commit it as it came out. These files are marked `-text` in `.gitattributes`
and exempt from `.editorconfig` trimming, because a line ending conversion or
a stripped trailing space would change what the parser is tested against.

## If you change how the screen is drawn

`assets/screen.svg` is drawn by the program's own rendering code, so it can be
redrawn rather than screenshotted:

```bash
node assets/make-screenshot.mjs > assets/screen.svg
node assets/make-screenshot.mjs --json > frame.json
python assets/make-png.py frame.json assets/screen.png   # needs Pillow
```

CI redraws it and fails if the committed file differs, because a picture that
drifts from the program is a picture that lies. The README shows the PNG,
because npmjs.com strips SVG out of a README; the SVG is the master that CI
compares against, and the PNG is drawn from the same frame. The processes in it are
invented: a real machine puts real user names and real project paths into every
row, and those do not belong in a public repository.

## Commits and pull requests

Commit subjects are sentences in the imperative, describing the change in terms
of behaviour: *Clamp every line at the one place they are written*, not
*fix(tui): clamp lines*. The body carries the reasoning, the same way the
comments do.

Open a pull request against `main`. CI runs nine build-and-test jobs across
three operating systems and three Node versions, plus the package-contents and
picture checks; all of them have to pass.

## Where help is wanted

Known gaps, all of them real:

- **The Linux and macOS collectors are barely covered.** They read `/proc` and
  spawn `ss` and `lsof` directly, so testing them means a filesystem seam that
  does not exist yet. Their parsers, where the difficult part lives, are at
  99%; the Windows collector has the seam already and is at 100%, which is
  roughly the shape the other two want.
- **`askYesNo` is untested**, because it builds a readline interface over the
  real stdin. Everything that decides whether it is called is covered.
- **Linux start times assume `USER_HZ` is 100.** True on mainstream kernels,
  stated in the platform notes, not read from `sysconf`.
- **The role table is a heuristic, not a registry.** Every tool it has not been
  taught reads as `unknown`.
- **macOS is the least exercised platform.** The parsers have fixtures and CI
  runs there, but it has had the least use on a real desk.

## Releasing

For maintainers.

1. `npm run typecheck && npm test && npm run build`
2. `node .github/scripts/smoke.mjs` and `node .github/scripts/check-package.mjs`
3. Redraw `assets/screen.svg` and `assets/screen.png` if the screen changed;
   the version in the footer comes from `package.json`, so a bump changes it
4. Update `CHANGELOG.md`, move everything out of *Unreleased*
5. Bump the version in `package.json`, commit
6. `git tag -a vX.Y.Z` with the changelog entry as the message, and push the tag

Pushing the tag is the whole release. The `Release` workflow verifies on all
three operating systems, refuses to publish if the tag and `package.json`
disagree, and publishes to npm with provenance. Nothing is published from a
laptop: 0.1.0 and 0.2.0 both were, and neither left a tag behind to say which
commit they came from.
