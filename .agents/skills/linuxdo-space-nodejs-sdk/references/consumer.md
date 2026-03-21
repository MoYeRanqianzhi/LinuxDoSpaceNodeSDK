# Consumer Guide

## Install

Preferred release-tarball install:

```bash
npm install https://github.com/MoYeRanqianzhi/LinuxDoSpaceNodeSDK/releases/download/v0.1.0-alpha.1/linuxdospace-0.1.0-alpha.1.tgz
```

Alternative tag-pinned git install:

```bash
npm install github:MoYeRanqianzhi/LinuxDoSpaceNodeSDK#v0.1.0-alpha.1
```

Import shape:

```ts
import { Client, Suffix } from "linuxdospace";
```

## Full stream

```ts
const client = await Client.connect({ token: "lds_pat..." });
try {
  for await (const item of client.listen(60)) {
    console.log(item.address, item.subject);
  }
} finally {
  client.close();
}
```

## Mailbox binding

```ts
const mailbox = client.mail.bind({
  prefix: "alice",
  suffix: Suffix.linuxdo_space,
});

for await (const item of mailbox.listen(60)) {
  console.log(item.subject);
}
```

## Key semantics

- Timeouts passed to `listen(...)` are seconds.
- `route(message)` is local matching only.
- Full-stream messages use a first-recipient projection address.
- Mailbox messages use matched-recipient projection addresses.
