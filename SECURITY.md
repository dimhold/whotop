# Security policy

## Supported versions

The latest published version is the supported one. whotop is small and has no
runtime dependencies, so fixes go out as a new release rather than as a
backport.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | yes       |
| < 0.3   | no        |

## Reporting a vulnerability

Report privately, not as a public issue.

- **Preferred:** [open a private advisory](https://github.com/dimhold/whotop/security/advisories/new)
  through GitHub's private vulnerability reporting.
- **Or:** email <dimhold@gmail.com> with `whotop` in the subject.

Please include the platform, the whotop version, and enough detail to reproduce
it. Expect an acknowledgement within a week. If a fix is warranted you will be
credited in the advisory and the changelog unless you would rather not be.

## What the threat model actually is

Worth stating plainly, because whotop does two things that deserve care.

**It runs system commands and parses their output.** PowerShell with an
`-EncodedCommand` on Windows, `ss` and `lsof` and `/proc` on Unix. The scripts
are constants in the source; no part of a process name, path or command line is
ever interpolated into a command line. A parser that could be made to execute
something by a crafted process name would be a serious bug, and is worth
reporting.

**It sends signals to processes.** `whotop kill` and the `x` key resolve a
target, show you exactly what they resolved, and ask before acting; `--yes`
skips the question and refuses to run without a terminal unless it is passed.
A path that kills a different process than the one it displayed is the most
serious bug this project can have. That is why the cursor follows a pid rather
than a row number, and why a report about it will be treated as a security
issue and not a correctness one.

**It reads a machine and prints what it finds.** Command lines, working
directories and project names are exactly the sort of thing that should not be
pasted into a public issue. The issue templates say so; whotop itself never
sends anything anywhere, makes no network connections, and writes no files.

## Out of scope

- Anything that requires an attacker to already run code as your user. They can
  read the process table without whotop's help.
- Processes that withhold their command line from an unelevated whotop. That is
  the operating system doing its job, and `--explain` reports it as a limit
  rather than working around it.
