## What this changes

<!-- The behaviour, not the diff. What could somebody do after this that they could not before, or what did whotop get wrong that it now gets right? -->

## Why

<!-- The reasoning belongs in the code as a comment, and a copy of it here saves the reviewer from reconstructing it. If this fixes something that was wrong, say what the wrong behaviour was. -->

## Checked

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node .github/scripts/smoke.mjs` on the platform I changed, if I changed a collector
- [ ] `node assets/make-screenshot.mjs > assets/screen.svg`, if I changed how the screen is drawn

## Platforms

<!-- Which of Windows, Linux and macOS you ran this on. CI covers all three, but say which one you actually watched, because a live process table shows things a fixture cannot. -->

<!--
A parser change wants a fixture: real output captured from a real machine,
added under test/fixtures. A rule reasoned out in the abstract produces
confident rows out of nothing, which is the failure this tool is built to
avoid.
-->
