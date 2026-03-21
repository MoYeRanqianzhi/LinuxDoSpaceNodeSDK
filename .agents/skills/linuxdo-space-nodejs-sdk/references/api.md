# API Reference

## Paths

- SDK root: `../../../`
- Package metadata: `../../../package.json`
- Public exports: `../../../src/index.ts`
- Core implementation: `../../../src/client.ts`
- Consumer README: `../../../README.md`

## Public surface

- Types / errors:
  - `Client`
  - `MailBindingFacade`
  - `MailBindingGroup`
  - `MailBox`
  - `Suffix`
  - `AuthenticationError`
  - `LinuxDoSpaceError`
  - `StreamError`
- Client:
  - `Client.connect(options)`
  - constructor `new Client(options)`
  - `listen(timeoutSeconds = -1)`
  - `waitUntilReady()`
  - `close()`
  - `closed()`
  - `client.mail`
- `client.mail`:
  - `bind(...)`
  - `spec(...)`
  - `bindMany(...)`
  - `unbind(...)`
  - `catchAll(...)`
  - `route(message)`
- MailBox:
  - `listen(timeoutSeconds = -1)`
  - `close()`
  - readonly metadata properties

## Semantics

- `Client.connect(...)` waits for initial readiness.
- `listen(...)` returns async iterators.
- `allowOverlap=false` stops at first match.
- Regex bindings are full-match local-part regexes.

