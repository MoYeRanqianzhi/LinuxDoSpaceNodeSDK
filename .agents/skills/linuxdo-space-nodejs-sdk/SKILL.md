---
name: linuxdo-space-nodejs-sdk
description: Use when writing or fixing Node.js or TypeScript code that consumes or maintains the LinuxDoSpace Node.js SDK under sdk/nodejs. Use for release-tarball integration, Client.connect usage, async-iterator full stream consumption, mailbox bindings, allowOverlap semantics, lifecycle/error handling, and local validation.
---

# LinuxDoSpace Node.js SDK

Read [references/consumer.md](references/consumer.md) first for normal SDK usage.
Read [references/api.md](references/api.md) for exact public Node.js API names.
Read [references/examples.md](references/examples.md) for task-shaped snippets.
Read [references/development.md](references/development.md) only when editing `sdk/nodejs`.

## Workflow

1. Prefer the public package import `import { Client, Suffix } from "linuxdospace";`.
2. The SDK root relative to this `SKILL.md` is `../../../`.
3. Preserve these invariants:
   - one `Client` owns one upstream HTTPS stream
   - `Client.connect(...)` waits for initial readiness
   - `client.listen(timeoutSeconds)` is the full-stream async iterator
   - `client.mail.bind(...)` creates local mailbox bindings
   - `mailbox.listen(timeoutSeconds)` is the mailbox async iterator
   - mailbox queues activate only while mailbox listen is active
   - `Suffix.linuxdo_space` is semantic and resolves after `ready.owner_username`
   - exact and regex bindings share one ordered chain per suffix
   - `allowOverlap=false` stops at first match; `true` continues
4. Keep README, source, package metadata, and workflows aligned when behavior changes.
5. Validate with the commands in `references/development.md`.

## Do Not Regress

- Do not document public npm registry publication; current install path is release tarball or tag-pinned git.
- Do not confuse `timeoutSeconds` with milliseconds.
- Do not add hidden pre-listen mailbox buffering.

