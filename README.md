# LinuxDoSpace Node.js SDK (TypeScript)

This SDK consumes LinuxDoSpace mail events from one HTTPS NDJSON stream:

- `GET /v1/token/email/stream`
- `Authorization: Bearer <token>`
- stream events: `ready`, `heartbeat`, `mail`

The runtime model follows the same core semantics as the Python SDK:

- one `Client` keeps one upstream stream connection
- `client.listen()` receives all token-visible mail events
- mailbox bindings are local and ordered per suffix
- exact + regex bindings share one chain
- `allowOverlap=false` stops at first match
- `allowOverlap=true` continues matching
- mailbox queues activate only while `mailbox.listen()` is active

## Install

```bash
npm install github:MoYeRanqianzhi/LinuxDoSpaceNodeSDK
```

Local repository development:

```bash
npm install
npm run build
```

## Quick Start

```ts
import { Client, Suffix } from "linuxdospace";

const client = await Client.connect({ token: "your-api-token" });
try {
  for await (const item of client.listen(60)) {
    console.log(item.address, item.sender, item.subject);
  }
} finally {
  client.close();
}
```

## Exact Binding

```ts
import { Client, Suffix } from "linuxdospace";

const client = await Client.connect({ token: "your-api-token" });
const mailbox = client.mail.bind({
  prefix: "alice",
  suffix: Suffix.linuxdo_space
});

try {
  for await (const item of mailbox.listen(60)) {
    console.log(item.subject);
  }
} finally {
  mailbox.close();
  client.close();
}
```

## Regex Binding

```ts
import { Client, Suffix } from "linuxdospace";

const client = await Client.connect({ token: "your-api-token" });
const catchAll = client.mail.bind({
  pattern: ".*",
  suffix: Suffix.linuxdo_space,
  allowOverlap: true
});

try {
  for await (const item of catchAll.listen(60)) {
    console.log(item.address, item.subject);
  }
} finally {
  catchAll.close();
  client.close();
}
```

## Batch Bindings

```ts
import { Client, Suffix } from "linuxdospace";

const client = await Client.connect({ token: "your-api-token" });
const group = client.mail.bindMany(
  client.mail.spec({ pattern: ".*", suffix: Suffix.linuxdo_space, allowOverlap: true }),
  client.mail.spec({ prefix: "alice", suffix: Suffix.linuxdo_space }),
  client.mail.spec({ prefix: "bob", suffix: Suffix.linuxdo_space })
);

try {
  const alice = group.at(1);
  for await (const item of alice.listen(60)) {
    console.log(item.subject);
  }
} finally {
  group.close();
  client.close();
}
```

## Release Note

The current release workflow publishes GitHub Release artifacts and `npm pack` tarballs.
It does not publish to the public npm registry yet.

## Local Routing Helper

`client.mail.route(message)` only uses `message.address` and reports current local
matches. It does not replay historical queue delivery.

```ts
import { Client, Suffix } from "linuxdospace";

const client = await Client.connect({ token: "your-api-token" });
const catchAll = client.mail.bind({
  pattern: ".*",
  suffix: Suffix.linuxdo_space,
  allowOverlap: true
});
const alice = client.mail.bind({
  prefix: "alice",
  suffix: Suffix.linuxdo_space
});

try {
  for await (const item of client.listen(60)) {
    const targets = client.mail.route(item);
    console.log(item.address, targets.map((t) => t.pattern ?? t.address));
  }
} finally {
  client.mail.unbind(catchAll, alice);
  client.close();
}
```

## Errors

- `AuthenticationError`: token rejected (`401/403`)
- `StreamError`: stream connection or NDJSON decode failure
- `LinuxDoSpaceError`: base SDK error type

## Connection Tuning

- `connectTimeoutMs` controls the initial stream-open timeout.
- `streamTimeoutMs` controls the idle timeout after the stream is already open.
- `reconnectDelayMs` controls the delay before retrying recoverable stream failures.
