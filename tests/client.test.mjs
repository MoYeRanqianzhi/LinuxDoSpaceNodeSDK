import assert from "node:assert/strict";
import test from "node:test";

import { Client, Suffix } from "../dist/index.js";

const TEST_OWNER_USERNAME = "testuser";
const TEST_NAMESPACE_SUFFIX = `${TEST_OWNER_USERNAME}.linuxdo.space`;

function createControllableStream() {
  let controllerRef = null;
  const pendingLines = [];
  return {
    stream: new ReadableStream({
      start(controller) {
        controllerRef = controller;
        while (pendingLines.length > 0) {
          controller.enqueue(Buffer.from(`${pendingLines.shift()}\n`, "utf8"));
        }
      },
      cancel() {
        controllerRef = null;
      }
    }),
    emitLine(line) {
      if (controllerRef === null) {
        pendingLines.push(line);
        return;
      }
      controllerRef.enqueue(Buffer.from(`${line}\n`, "utf8"));
    },
    close() {
      controllerRef?.close();
      controllerRef = null;
    }
  };
}

function installFetch(mock) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    if (normalizedUrl.endsWith("/v1/token/email/filters") && method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    return mock(url, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function attachAbort(signal, stream) {
  if (signal == null) {
    return;
  }
  if (signal.aborted) {
    stream.close();
    return;
  }
  signal.addEventListener("abort", () => stream.close(), { once: true });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out while waiting for condition");
}

function makeReadyLine() {
  return JSON.stringify({
    type: "ready",
    token_public_id: "tok_123",
    owner_username: TEST_OWNER_USERNAME
  });
}

function makeMailLine(recipients) {
  const raw = Buffer.from(
    `From: sender@example.com\r\nTo: ${recipients.join(", ")}\r\nSubject: Hello\r\n\r\nBody`,
    "utf8"
  ).toString("base64");
  return JSON.stringify({
    type: "mail",
    original_envelope_from: "sender@example.com",
    original_recipients: recipients,
    received_at: "2026-03-20T10:11:12Z",
    raw_message_base64: raw
  });
}

function makeMessage(address) {
  return {
    address,
    sender: "sender@example.com",
    recipients: [address],
    receivedAt: new Date("2026-03-20T10:11:12Z"),
    subject: "",
    messageId: null,
    date: null,
    fromHeader: "",
    toHeader: "",
    ccHeader: "",
    replyToHeader: "",
    fromAddresses: [],
    toAddresses: [],
    ccAddresses: [],
    replyToAddresses: [],
    text: "",
    html: "",
    headers: {},
    raw: "",
    rawBytes: new Uint8Array(),
    parsed: null
  };
}

test("client.mail.route preserves bind order and overlap semantics", async () => {
  const stream = createControllableStream();
  stream.emitLine(makeReadyLine());
  const restoreFetch = installFetch(async (_url, init = {}) => {
    attachAbort(init.signal, stream);
    return new Response(stream.stream, { status: 200 });
  });

  const client = await Client.connect({
    token: "test-token",
    baseUrl: "http://localhost:8787"
  });

  try {
    const catchAll = client.mail.bind({
      pattern: ".*",
      suffix: Suffix.linuxdo_space,
      allowOverlap: true
    });
    const alice = client.mail.bind({
      prefix: "alice",
      suffix: Suffix.linuxdo_space
    });

    const routed = client.mail.route(makeMessage(`alice@${TEST_NAMESPACE_SUFFIX}`));
    assert.equal(routed.length, 2);
    assert.equal(routed[0], catchAll);
    assert.equal(routed[1], alice);
  } finally {
    client.close();
    await client.closed();
    restoreFetch();
  }
});

test("semantic suffix also matches the current mail namespace", async () => {
  const stream = createControllableStream();
  stream.emitLine(makeReadyLine());
  const restoreFetch = installFetch(async (_url, init = {}) => {
    attachAbort(init.signal, stream);
    return new Response(stream.stream, { status: 200 });
  });

  const client = await Client.connect({
    token: "test-token",
    baseUrl: "http://localhost:8787"
  });

  try {
    const alice = client.mail.bind({
      prefix: "alice",
      suffix: Suffix.linuxdo_space
    });

    const routed = client.mail.route(makeMessage("alice@testuser-mail.linuxdo.space"));
    assert.equal(routed.length, 1);
    assert.equal(routed[0], alice);
  } finally {
    client.close();
    await client.closed();
    restoreFetch();
  }
});

test("mailboxes receive the concrete recipient address for multi-recipient mail", async () => {
  const stream = createControllableStream();
  const restoreFetch = installFetch(async (_url, init = {}) => {
    attachAbort(init.signal, stream);
    return new Response(stream.stream, { status: 200 });
  });
  stream.emitLine(makeReadyLine());

  const client = await Client.connect({
    token: "test-token",
    baseUrl: "http://localhost:8787"
  });

  try {
    const alice = client.mail.bind({
      prefix: "alice",
      suffix: Suffix.linuxdo_space
    });
    const bob = client.mail.bind({
      prefix: "bob",
      suffix: Suffix.linuxdo_space
    });

    const aliceIterator = alice.listen(2);
    const bobIterator = bob.listen(2);
    const aliceNext = aliceIterator.next();
    const bobNext = bobIterator.next();

    stream.emitLine(makeMailLine([`alice@${TEST_NAMESPACE_SUFFIX}`, `bob@${TEST_NAMESPACE_SUFFIX}`]));

    const aliceResult = await aliceNext;
    const bobResult = await bobNext;
    assert.equal(aliceResult.value?.address, `alice@${TEST_NAMESPACE_SUFFIX}`);
    assert.equal(bobResult.value?.address, `bob@${TEST_NAMESPACE_SUFFIX}`);
  } finally {
    client.close();
    await client.closed();
    restoreFetch();
  }
});

test("streamTimeoutMs triggers reconnect after an idle open stream", async () => {
  let fetchCount = 0;
  const restoreFetch = installFetch(async (_url, init = {}) => {
    fetchCount += 1;
    const stream = createControllableStream();
    stream.emitLine(makeReadyLine());
    attachAbort(init.signal, stream);
    return new Response(stream.stream, { status: 200 });
  });

  const client = await Client.connect({
    token: "test-token",
    baseUrl: "http://localhost:8787",
    streamTimeoutMs: 50,
    reconnectDelayMs: 10
  });

  try {
    await waitFor(() => fetchCount >= 2, 1_500);
    assert.ok(fetchCount >= 2);
  } finally {
    client.close();
    await client.closed();
    restoreFetch();
  }
});
