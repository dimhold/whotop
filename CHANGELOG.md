# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-20

The interactive screen stops looking like it has hung, the detail pane shows
what a process actually discloses, and the repository grows the parts an open
source project is expected to have.

### Added

- **A splash while the machine is read.** The screen took a little over two
  seconds to open and showed nothing at all while it did, which reads as a
  hang. It now names the command it is waiting on, counts the seconds, and
  shows the keys, so the wait teaches something. Past six seconds it says the
  wait is unusual; past fifteen it says how to get out.
- **ctrl-c works during that wait.** Raw mode turns ctrl-c into a byte rather
  than a signal, and until now nothing was reading bytes before the key loop
  started. Anything else typed while the screen loads is kept and replayed once
  there is a list to apply it to, so a `/` typed early still opens the search.
- **A marker while a refresh is in flight**, drawn before the wait rather than
  after it, so pressing `r` visibly does something.
- **Continuous integration** across Windows, Linux and macOS on Node 18.17, 22
  and 24. Each job builds and then reads the runner's own process table, which
  is the only check that would notice a collector breaking on a platform nobody
  develops on. Separate jobs assert what the package would publish and that the
  README picture still matches the program.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull
  request templates, Dependabot, and this changelog.
- **`whotop version` and `whotop help` as words**, not only as flags. Any word
  that is not a subcommand is a filter, so `whotop version` had been quietly
  listing the processes whose command line contains "version" and exiting 0.
  A wrong answer that looks like a right one is worse than an error. To search
  for the word itself, `whotop ls version`.
- **The exit codes are documented** in the README and in `--help`: 0 answered,
  1 nothing matched, 2 bad usage, 3 the process table could not be read.

### Changed

- **Coverage went from 73% to 89%**, and there is now a floor under it that CI
  enforces. 94 tests were added, 268 to 362. The two largest untested things
  in the project were the half of the interactive screen that owns a terminal,
  and `main` itself — the composition every exit code and every subcommand
  goes through. Both are covered against a fake terminal and an injected
  reader, with nothing stubbed in between. The public API surface is written
  down as a test, so an export cannot fall out of it unnoticed.
- **The detail pane is twelve lines rather than eight.** A typical process
  discloses more than seven lines and the eighth was spent on the marker saying
  so, which left six. It is still fixed against its contents, but no longer
  fixed against the screen: on a short terminal it gives lines back to the list
  rather than push the footer off the bottom, and under three lines it steps
  aside entirely.
- Line endings are LF in the repository, declared in `.gitattributes` and
  `.editorconfig`. Recorded fixtures are exempt and stay byte for byte as
  captured.

### Fixed

- **`whotop kill` can be answered by an embedding caller.** The refusal to
  kill without a terminal was checking for a terminal rather than for a way to
  ask, so a caller that supplied its own confirmation was refused anyway.
- **The screen no longer leaves its handlers on `process`.** The CLI exits
  immediately and would never notice; a program that used whotop as a library
  and opened the screen twice would have been left holding two sets.
- **A failed collect no longer swallows its own error message.** The alternate
  screen was discarded on the way out and took the explanation with it, leaving
  a blank terminal and no reason.
- The splash and the footer stamp the version the same way; the screenshot
  generator reads the pane height and the version from the program instead of
  having them written down, after drawing an eight line pane and stamping
  v0.1.0 for the whole of 0.2.0.

### Removed

- **Source maps are no longer published.** All 42 of them named a `src`
  directory the package does not contain and embedded no sources, so 43% of the
  build was a map of a place the reader cannot go. Packed 103.1 kB to 72.5 kB,
  unpacked 401.5 kB to 235.5 kB, 87 files to 45.
- `REPO-NOTES.md`, whose contents now live in `CONTRIBUTING.md` where
  contributors will find them.

### Security

- Real paths from the author's machine are out of the README and the tests: a
  Windows account name and two private project names. The invented processes in
  the picture existed for exactly this reason and the prose did not follow.

## [0.2.0] - 2026-08-20

### Added

- **Naming a process by the trace it left on disk.** A command line that says
  nothing about its work often has a directory that does: Claude Code writes
  `<temp>/claude/<encoded project path>/<session id>/` in the first seconds of a
  session, so a process that started at 18:48:22 and a directory created at
  18:48:21 are the same session. This is what stops five identical
  `claude.exe --resume` rows from being identical.

  It is a time correlation and says so. The value is never `exact`, only
  `inferred` with the directory and the time difference in the note, or
  `unavailable` with the reason. Two thresholds decide, both named constants:
  45 seconds between process start and directory creation, and a 2 second gap
  between the best candidate and the next one, inside which the row reports
  nothing rather than guess. A directory name is a lossy encoding, so it is
  decoded by walking the disk rather than by string surgery, and reports nothing
  when the answer is not unique.

  The scan only runs when the process table actually contains a process some
  rule speaks for, so the common listing costs nothing.

- The README picture is generated as a PNG as well as an SVG, since npmjs.com
  strips SVG out of a README, from the same frame so the two cannot disagree.

## [0.1.0] - 2026-08-19

First release.

### Added

- **Reads the process table and the socket table and joins them**, so a screen
  full of `node` and `python` becomes a list of roles, ports, working
  directories and projects.
- **Role classification** from the command line: agent session, MCP server, dev
  server, test runner, browser automation, database, watcher, language server
  and a dozen more.
- **Ports each process holds**, listening ones first.
- **Orphan detection**, which on Windows compares start times because a parent
  pid keeps pointing at a number the system is free to reuse.
- **Project resolution** from the nearest `package.json` above the working
  directory, so two `vite` processes are told apart by where they run.
- **Names from the operating system's own service registry**, which needs no
  elevation and named 115 of the 164 processes that disclosed nothing else on a
  443 process Windows machine, a WireGuard tunnel and CloudflareWARP among them.
- **`--explain`**, under which every role names the rule that produced it and
  every platform lists what it refused to disclose.
- **Kill by port or pid**, after showing exactly what was resolved and asking.
- **An interactive screen**: scroll, search, a middle column that cycles between
  what a process is, where it runs and the command it ran, and a detail pane
  that follows the cursor. The cursor follows a pid rather than a row number,
  because a refresh reorders the list and killing the row the cursor drifted
  onto is the mistake this tool exists to prevent.
- **Three collectors** — PowerShell and WMI on Windows, `/proc` and `ss` on
  Linux, `ps` and `lsof` on macOS — with parsing kept separate from spawning
  and tested against recorded output from real machines.
- **Zero runtime dependencies**, so `npx whotop` is one download with no supply
  chain to audit.

[Unreleased]: https://github.com/dimhold/whotop/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/dimhold/whotop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dimhold/whotop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dimhold/whotop/releases/tag/v0.1.0
