# Task Templates

## Create one exact mailbox

```ts
const alice = client.mail.bind({
  prefix: "alice",
  suffix: Suffix.linuxdo_space,
});
```

## Create one catch-all

```ts
const catchAll = client.mail.bind({
  pattern: ".*",
  suffix: Suffix.linuxdo_space,
  allowOverlap: true,
});
```

## Route one full-stream message

```ts
const matches = client.mail.route(message);
```
