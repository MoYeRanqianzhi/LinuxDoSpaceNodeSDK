import { simpleParser } from "mailparser";
import { AsyncQueue } from "./asyncQueue.js";
import { AuthenticationError, LinuxDoSpaceError, StreamError } from "./errors.js";
import { SemanticSuffix, Suffix } from "./types.js";
import type { ClientOptions, MailBindingSpec, MailMessage } from "./types.js";

const DEFAULT_BASE_URL = "https://api.linuxdo.space";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STREAM_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 300;
const STREAM_PATH = "/v1/token/email/stream";
const STREAM_FILTERS_PATH = "/v1/token/email/filters";
const CONNECT_TIMEOUT_ABORT_REASON = "linuxdospace-connect-timeout";
const STREAM_TIMEOUT_ABORT_REASON = "linuxdospace-stream-timeout";
const CLOSE_ABORT_REASON = "linuxdospace-client-close";

type BindingMode = "exact" | "pattern";

interface ParsedEnvelope {
  sender: string;
  recipients: readonly string[];
  receivedAt: Date;
  subject: string;
  messageId: string | null;
  date: Date | null;
  fromHeader: string;
  toHeader: string;
  ccHeader: string;
  replyToHeader: string;
  fromAddresses: readonly string[];
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  replyToAddresses: readonly string[];
  text: string;
  html: string;
  headers: Readonly<Record<string, string>>;
  raw: string;
  rawBytes: Uint8Array;
  parsed: unknown;
}

interface AddressLike {
  value?: Array<{ address?: string }>;
}

interface ParsedMailLike {
  subject?: string;
  messageId?: string;
  date?: Date;
  from?: AddressLike;
  to?: AddressLike;
  cc?: AddressLike;
  replyTo?: AddressLike;
  text?: string;
  html?: unknown;
  headerLines?: Array<{ key: string; line: string }>;
}

interface NormalizedBindingInput {
  mode: BindingMode;
  suffix: string;
  allowOverlap: boolean;
  prefix: string | null;
  patternText: string | null;
  regex: RegExp | null;
}

interface MailBinding {
  mode: BindingMode;
  suffix: string;
  allowOverlap: boolean;
  prefix: string | null;
  patternText: string | null;
  regex: RegExp | null;
  mailbox: MailBox;
}

/**
 * MailBox is one registered local mailbox binding layered on top of one shared
 * client stream connection.
 */
export class MailBox {
  private readonly client: Client;
  private readonly unregister: () => void;
  private readonly modeValue: BindingMode;
  private readonly suffixValue: string;
  private readonly allowOverlapValue: boolean;
  private readonly prefixValue: string | null;
  private readonly patternValue: string | null;
  private queue: AsyncQueue<MailMessage> | null = null;
  private listening = false;
  private closedValue = false;

  public constructor(client: Client, binding: MailBinding, unregister: () => void) {
    this.client = client;
    this.unregister = unregister;
    this.modeValue = binding.mode;
    this.suffixValue = binding.suffix;
    this.allowOverlapValue = binding.allowOverlap;
    this.prefixValue = binding.prefix;
    this.patternValue = binding.patternText;
  }

  public get mode(): BindingMode {
    return this.modeValue;
  }

  public get suffix(): string {
    return this.suffixValue;
  }

  public get allowOverlap(): boolean {
    return this.allowOverlapValue;
  }

  public get prefix(): string | null {
    return this.prefixValue;
  }

  public get pattern(): string | null {
    return this.patternValue;
  }

  public get address(): string | null {
    if (this.modeValue !== "exact" || this.prefixValue === null) {
      return null;
    }
    return `${this.prefixValue}@${this.suffixValue}`;
  }

  public get closed(): boolean {
    return this.closedValue;
  }

  /**
   * listen() starts mailbox-level buffering only for this active call.
   * Messages arriving before listen() starts are intentionally not replayed.
   */
  public async *listen(timeout = -1): AsyncGenerator<MailMessage> {
    if (this.closedValue) {
      throw new LinuxDoSpaceError("mailbox is already closed");
    }
    if (this.listening) {
      throw new LinuxDoSpaceError("mailbox already has an active listener");
    }
    this.client.assertUsable();

    this.listening = true;
    const queue = new AsyncQueue<MailMessage>();
    this.queue = queue;
    const deadline = timeout < 0 ? null : Date.now() + Math.floor(timeout * 1000);

    try {
      while (!this.closedValue) {
        const remainingMs = deadline === null ? null : Math.max(0, deadline - Date.now());
        if (remainingMs !== null && remainingMs <= 0) {
          return;
        }
        const next = await queue.next(remainingMs === null ? undefined : remainingMs);
        if (next === null) {
          return;
        }
        yield next;
      }
    } finally {
      if (this.queue === queue) {
        this.queue = null;
      }
      this.listening = false;
    }
  }

  public close(): void {
    if (this.closedValue) {
      return;
    }
    this.closedValue = true;
    this.unregister();
    this.queue?.close();
    this.queue = null;
  }

  public enqueue(message: MailMessage): void {
    this.queue?.push(message);
  }

  public fail(error: Error): void {
    this.queue?.fail(error);
  }
}

/**
 * MailBindingGroup contains one batch of bindings created by bindMany().
 */
export class MailBindingGroup implements Iterable<MailBox> {
  private readonly mailboxesValue: readonly MailBox[];
  private closedValue = false;

  public constructor(mailboxes: readonly MailBox[]) {
    this.mailboxesValue = mailboxes;
  }

  public get closed(): boolean {
    return this.closedValue;
  }

  public get size(): number {
    return this.mailboxesValue.length;
  }

  public at(index: number): MailBox {
    const mailbox = this.mailboxesValue[index];
    if (mailbox === undefined) {
      throw new RangeError(`mailbox index out of range: ${index}`);
    }
    return mailbox;
  }

  public [Symbol.iterator](): Iterator<MailBox> {
    return this.mailboxesValue[Symbol.iterator]();
  }

  public close(): void {
    if (this.closedValue) {
      return;
    }
    this.closedValue = true;
    for (const mailbox of this.mailboxesValue) {
      mailbox.close();
    }
  }
}

/**
 * MailBindingFacade exposes explicit mailbox registration APIs as client.mail.
 */
export class MailBindingFacade {
  private readonly client: Client;

  public constructor(client: Client) {
    this.client = client;
  }

  public bind(input: {
    prefix?: string;
    pattern?: string | RegExp;
    suffix: Suffix | SemanticSuffix | string;
    allowOverlap?: boolean;
  }): MailBox {
    return this.client.createMailbox(input);
  }

  public spec(input: {
    prefix?: string;
    pattern?: string | RegExp;
    suffix: Suffix | SemanticSuffix | string;
    allowOverlap?: boolean;
  }): MailBindingSpec {
    return {
      suffix: input.suffix,
      prefix: input.prefix,
      pattern: input.pattern,
      allowOverlap: input.allowOverlap ?? false
    };
  }

  public bindMany(...specs: MailBindingSpec[]): MailBindingGroup {
    if (specs.length === 0) {
      throw new ValueError("at least one MailBindingSpec must be provided");
    }
    const normalizedSpecs = specs.map((spec) => this.client.normalizeBindingInput(spec));
    const created: MailBox[] = [];
    try {
      for (const normalized of normalizedSpecs) {
        created.push(this.client.createMailboxFromNormalized(normalized));
      }
      return new MailBindingGroup(created);
    } catch (error) {
      for (const mailbox of created) {
        mailbox.close();
      }
      throw error;
    }
  }

  public unbind(...targets: Array<MailBox | MailBindingGroup>): void {
    for (const target of targets) {
      target.close();
    }
  }

  public catchAll(input: {
    suffix: Suffix | SemanticSuffix | string;
    pattern?: string | RegExp;
    allowOverlap?: boolean;
  }): MailBox {
    return this.bind({
      suffix: input.suffix,
      pattern: input.pattern ?? ".*",
      allowOverlap: input.allowOverlap
    });
  }

  /**
   * route() is a read-only local routing helper based on message.address only.
   */
  public route(message: MailMessage): readonly MailBox[] {
    return this.client.resolveMailboxesForMessage(message);
  }
}

/**
 * Client is the top-level SDK object.
 * One Client owns exactly one upstream HTTPS stream and performs local routing.
 */
export class Client {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly streamTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly allListeners = new Set<AsyncQueue<MailMessage>>();
  private readonly bindingsBySuffix = new Map<string, MailBinding[]>();
  private readonly mailboxes = new Set<MailBox>();
  private readonly initialReady: Promise<void>;
  private resolveInitialReady!: () => void;
  private rejectInitialReady!: (error: Error) => void;
  private initialSettled = false;
  private running = true;
  private connectedValue = false;
  private fatalError: Error | null = null;
  private activeAbortController: AbortController | null = null;
  private ownerUsername: string | null = null;
  private syncedMailboxSuffixFragments: readonly string[] | null = null;
  private mailboxFilterSyncQueue: Promise<void> = Promise.resolve();
  private readonly runnerPromise: Promise<void>;

  public readonly mail: MailBindingFacade;

  public constructor(options: ClientOptions) {
    this.token = options.token.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.streamTimeoutMs = options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    if (this.token.length === 0) {
      throw new ValueError("token must not be empty");
    }
    if (this.connectTimeoutMs <= 0) {
      throw new ValueError("connectTimeoutMs must be greater than 0");
    }
    if (this.streamTimeoutMs <= 0) {
      throw new ValueError("streamTimeoutMs must be greater than 0");
    }
    if (this.reconnectDelayMs <= 0) {
      throw new ValueError("reconnectDelayMs must be greater than 0");
    }

    this.initialReady = new Promise<void>((resolve, reject) => {
      this.resolveInitialReady = resolve;
      this.rejectInitialReady = reject;
    });

    this.mail = new MailBindingFacade(this);
    this.runnerPromise = this.runStreamLoop();
  }

  /**
   * connect() is the strict constructor helper that enforces initial stream
   * connection success before returning the client.
   */
  public static async connect(options: ClientOptions): Promise<Client> {
    const client = new Client(options);
    await client.waitUntilReady();
    return client;
  }

  public get connected(): boolean {
    return this.connectedValue && this.fatalError === null && this.running;
  }

  public async waitUntilReady(): Promise<void> {
    await this.initialReady;
  }

  public assertUsable(): void {
    if (!this.running) {
      throw new LinuxDoSpaceError("client is already closed");
    }
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
  }

  /**
   * listen() yields all mail events exposed by the token stream.
   */
  public async *listen(timeout = -1): AsyncGenerator<MailMessage> {
    this.assertUsable();
    const queue = new AsyncQueue<MailMessage>();
    this.allListeners.add(queue);
    const deadline = timeout < 0 ? null : Date.now() + Math.floor(timeout * 1000);

    try {
      while (this.running) {
        const remainingMs = deadline === null ? null : Math.max(0, deadline - Date.now());
        if (remainingMs !== null && remainingMs <= 0) {
          return;
        }
        const next = await queue.next(remainingMs === null ? undefined : remainingMs);
        if (next === null) {
          return;
        }
        yield next;
      }
    } finally {
      this.allListeners.delete(queue);
      queue.close();
    }
  }

  public close(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.connectedValue = false;
    this.activeAbortController?.abort(CLOSE_ABORT_REASON);

    for (const listener of this.allListeners) {
      listener.close();
    }
    this.allListeners.clear();

    for (const mailbox of this.mailboxes) {
      mailbox.close();
    }
    this.mailboxes.clear();

    if (!this.initialSettled) {
      this.initialSettled = true;
      this.rejectInitialReady(new LinuxDoSpaceError("client closed before initial stream became ready"));
    }
  }

  public async closed(): Promise<void> {
    await this.runnerPromise;
  }

  private async runStreamLoop(): Promise<void> {
    let firstAttempt = true;
    while (this.running && this.fatalError === null) {
      try {
        await this.consumeStreamOnce();
        firstAttempt = false;
        this.connectedValue = false;
      } catch (error) {
        this.connectedValue = false;
        const normalized = normalizeError(error);
        if (normalized instanceof AuthenticationError) {
          this.failAll(normalized);
          return;
        }
        if (firstAttempt && !this.initialSettled) {
          this.failAll(normalized);
          return;
        }
      }

      if (!this.running || this.fatalError !== null) {
        return;
      }
      await sleep(this.reconnectDelayMs);
    }
  }

  private async consumeStreamOnce(): Promise<void> {
    const controller = new AbortController();
    this.activeAbortController = controller;
    let connectTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(CONNECT_TIMEOUT_ABORT_REASON),
      this.connectTimeoutMs
    );
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    const clearIdleTimeout = (): void => {
      if (idleTimeout !== null) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    };
    const resetIdleTimeout = (): void => {
      clearIdleTimeout();
      idleTimeout = setTimeout(() => controller.abort(STREAM_TIMEOUT_ABORT_REASON), this.streamTimeoutMs);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await fetch(`${this.baseUrl}${STREAM_PATH}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/x-ndjson"
        },
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError("api token was rejected by the LinuxDoSpace backend");
      }
      if (!response.ok) {
        throw new StreamError(`unexpected stream status code: ${response.status}`);
      }
      if (response.body === null) {
        throw new StreamError("stream response body is empty");
      }

      if (connectTimeout !== null) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }

      this.connectedValue = true;
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";
      resetIdleTimeout();

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          const finalLine = buffered.trim();
          if (finalLine.length > 0) {
            await this.handleStreamLine(finalLine);
          }
          if (this.running && !this.initialSettled) {
            throw new StreamError("mail stream ended before ready event");
          }
          return;
        }
        resetIdleTimeout();
        buffered += decoder.decode(value, { stream: true });
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          if (line.length > 0) {
            await this.handleStreamLine(line);
          }
          newlineIndex = buffered.indexOf("\n");
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof StreamError) {
        throw error;
      }
      const unknown = normalizeError(error);
      if (controller.signal.aborted) {
        const reason = String(controller.signal.reason ?? "");
        if (!this.running || reason === CLOSE_ABORT_REASON) {
          return;
        }
        if (reason === STREAM_TIMEOUT_ABORT_REASON) {
          throw new StreamError("mail stream stalled and will reconnect");
        }
        if (reason === CONNECT_TIMEOUT_ABORT_REASON) {
          throw new StreamError("timed out while opening the LinuxDoSpace HTTPS mail stream");
        }
      }
      throw new StreamError(`failed to open LinuxDoSpace mail stream: ${unknown.message}`);
    } finally {
      if (connectTimeout !== null) {
        clearTimeout(connectTimeout);
      }
      clearIdleTimeout();
      reader?.releaseLock();
      this.activeAbortController = null;
    }
  }

  private async handleStreamLine(line: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new StreamError("received invalid JSON from the LinuxDoSpace mail stream");
    }

    const type = String(payload.type ?? "").trim().toLowerCase();
    if (type.length === 0) {
      throw new StreamError("received stream event without a type field");
    }
    if (type === "ready") {
      await this.handleReadyEvent(payload);
      return;
    }
    if (type === "heartbeat") {
      return;
    }
    if (type !== "mail") {
      return;
    }

    const envelope = await parseMailEvent(payload);
    this.dispatchEnvelope(envelope);
  }

  private dispatchEnvelope(envelope: ParsedEnvelope): void {
    const primaryAddress = envelope.recipients[0] ?? "";
    const fullMessage = projectMessage(envelope, primaryAddress);
    for (const queue of this.allListeners) {
      queue.push(fullMessage);
    }

    const delivered = new Set<string>();
    for (const recipient of envelope.recipients) {
      const normalized = recipient.trim().toLowerCase();
      if (normalized.length === 0 || delivered.has(normalized)) {
        continue;
      }
      delivered.add(normalized);
      const message = projectMessage(envelope, normalized);
      for (const binding of this.matchBindingsForAddress(normalized)) {
        binding.mailbox.enqueue(message);
      }
    }
  }

  private matchBindingsForAddress(address: string): readonly MailBinding[] {
    const splitIndex = address.indexOf("@");
    if (splitIndex <= 0 || splitIndex >= address.length - 1) {
      return [];
    }
    const localPart = address.slice(0, splitIndex);
    const suffix = address.slice(splitIndex + 1);
    let bindings = this.bindingsBySuffix.get(suffix) ?? [];
    if (bindings.length === 0) {
      const ownerUsername = (this.ownerUsername ?? "").trim().toLowerCase();
      if (ownerUsername.length > 0) {
        const semanticLegacySuffix = `${ownerUsername}.${Suffix.linuxdo_space}`;
        const semanticMailSuffix = `${ownerUsername}-mail.${Suffix.linuxdo_space}`;
        if (suffix === semanticLegacySuffix) {
          bindings = this.bindingsBySuffix.get(semanticMailSuffix) ?? [];
        }
      }
    }
    const matched: MailBinding[] = [];

    for (const binding of bindings) {
      if (!matchesBinding(binding, localPart)) {
        continue;
      }
      matched.push(binding);
      if (!binding.allowOverlap) {
        break;
      }
    }
    return matched;
  }

  public resolveMailboxesForMessage(message: MailMessage): readonly MailBox[] {
    return this.matchBindingsForAddress(message.address).map((item) => item.mailbox);
  }

  public normalizeBindingInput(input: {
    prefix?: string;
    pattern?: string | RegExp;
    suffix: Suffix | SemanticSuffix | string;
    allowOverlap?: boolean;
  }): NormalizedBindingInput {
    const hasPrefix = typeof input.prefix === "string";
    const hasPattern = typeof input.pattern === "string" || input.pattern instanceof RegExp;
    if (hasPrefix === hasPattern) {
      throw new ValueError("exactly one of prefix or pattern must be provided");
    }

    const suffix = this.resolveBindingSuffix(input.suffix);
    if (suffix.length === 0) {
      throw new ValueError("suffix must not be empty");
    }

    if (hasPrefix) {
      const prefix = String(input.prefix).trim().toLowerCase();
      if (prefix.length === 0) {
        throw new ValueError("prefix must not be empty");
      }
      return {
        mode: "exact",
        suffix,
        allowOverlap: Boolean(input.allowOverlap),
        prefix,
        patternText: null,
        regex: null
      };
    }

    const patternValue = input.pattern as string | RegExp;
    const patternText = patternValue instanceof RegExp ? patternValue.source : patternValue.trim();
    if (patternText.length === 0) {
      throw new ValueError("pattern must not be empty");
    }
    const regex = patternValue instanceof RegExp ? patternValue : new RegExp(patternText);

    return {
      mode: "pattern",
      suffix,
      allowOverlap: Boolean(input.allowOverlap),
      prefix: null,
      patternText,
      regex
    };
  }

  public createMailbox(input: {
    prefix?: string;
    pattern?: string | RegExp;
    suffix: Suffix | SemanticSuffix | string;
    allowOverlap?: boolean;
  }): MailBox {
    this.assertUsable();
    const normalized = this.normalizeBindingInput(input);
    return this.createMailboxFromNormalized(normalized);
  }

  public createMailboxFromNormalized(normalized: NormalizedBindingInput): MailBox {
    this.assertUsable();

    const list = this.bindingsBySuffix.get(normalized.suffix) ?? [];
    this.bindingsBySuffix.set(normalized.suffix, list);

    const binding: MailBinding = {
      mode: normalized.mode,
      suffix: normalized.suffix,
      allowOverlap: normalized.allowOverlap,
      prefix: normalized.prefix,
      patternText: normalized.patternText,
      regex: normalized.regex,
      mailbox: null as unknown as MailBox
    };

    const unregister = (): void => {
      const current = this.bindingsBySuffix.get(binding.suffix);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(binding);
      if (index >= 0) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        this.bindingsBySuffix.delete(binding.suffix);
      }
      this.mailboxes.delete(binding.mailbox);
      this.queueMailboxFilterSync(false);
    };

    const mailbox = new MailBox(this, binding, unregister);
    binding.mailbox = mailbox;
    list.push(binding);
    this.mailboxes.add(mailbox);
    this.queueMailboxFilterSync(true);
    return mailbox;
  }

  private queueMailboxFilterSync(strict: boolean): void {
    const run = async (): Promise<void> => {
      try {
        await this.syncRemoteMailboxFilters(strict);
      } catch (error) {
        if (!strict) {
          return;
        }
        const normalized = normalizeError(error);
        const syncError =
          normalized instanceof StreamError
            ? normalized
            : new StreamError(`failed to synchronize remote mailbox filters: ${normalized.message}`);
        this.failAll(syncError);
      }
    };

    this.mailboxFilterSyncQueue = this.mailboxFilterSyncQueue.catch(() => undefined).then(run);
  }

  private async syncRemoteMailboxFilters(strict: boolean): Promise<void> {
    if (!this.running) {
      return;
    }
    const ownerUsername = (this.ownerUsername ?? "").trim().toLowerCase();
    if (ownerUsername.length === 0) {
      return;
    }

    const fragments = this.collectRemoteMailboxSuffixFragments(ownerUsername);
    if (fragments.length === 0 && this.syncedMailboxSuffixFragments === null) {
      return;
    }
    if (arraysEqual(this.syncedMailboxSuffixFragments, fragments)) {
      return;
    }

    const response = await fetch(`${this.baseUrl}${STREAM_FILTERS_PATH}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ suffixes: fragments })
    });

    if (!response.ok) {
      if (!strict) {
        return;
      }
      throw new StreamError(`unexpected mailbox filter sync status code: ${response.status}`);
    }

    await response.text();
    this.syncedMailboxSuffixFragments = fragments;
  }

  private collectRemoteMailboxSuffixFragments(ownerUsername: string): readonly string[] {
    const rootSuffix = Suffix.linuxdo_space;
    const canonicalPrefix = `${ownerUsername}-mail`;
    const fragments = new Set<string>();

    for (const suffix of this.bindingsBySuffix.keys()) {
      const normalizedSuffix = suffix.trim().toLowerCase();
      if (!normalizedSuffix.endsWith(`.${rootSuffix}`)) {
        continue;
      }
      const label = normalizedSuffix.slice(0, -(rootSuffix.length + 1));
      if (label.includes(".") || !label.startsWith(canonicalPrefix)) {
        continue;
      }
      fragments.add(label.slice(canonicalPrefix.length));
    }

    return Array.from(fragments).sort();
  }

  private failAll(error: Error): void {
    this.fatalError = error;
    this.running = false;
    this.connectedValue = false;
    this.activeAbortController?.abort();

    if (!this.initialSettled) {
      this.initialSettled = true;
      this.rejectInitialReady(error);
    }

    for (const queue of this.allListeners) {
      queue.fail(error);
    }
    this.allListeners.clear();
    for (const mailbox of this.mailboxes) {
      mailbox.fail(error);
    }
  }

  private async handleReadyEvent(payload: Record<string, unknown>): Promise<void> {
    const ownerUsername = String(payload.owner_username ?? "").trim().toLowerCase();
    if (ownerUsername.length === 0) {
      throw new StreamError("LinuxDoSpace ready event did not include owner_username");
    }

    this.ownerUsername = ownerUsername;
    await this.syncRemoteMailboxFilters(true);
    if (!this.initialSettled) {
      this.initialSettled = true;
      this.resolveInitialReady();
    }
  }

  private resolveBindingSuffix(input: Suffix | SemanticSuffix | string): string {
    if (input instanceof SemanticSuffix) {
      if (input.base !== Suffix.linuxdo_space) {
        return String(input.base).trim().toLowerCase();
      }
      const ownerUsername = (this.ownerUsername ?? "").trim().toLowerCase();
      if (ownerUsername.length === 0) {
        throw new StreamError(
          "stream bootstrap did not provide owner_username required to resolve Suffix.withSuffix(...)"
        );
      }
      return `${ownerUsername}-mail${input.mailSuffixFragment}.${input.base}`;
    }

    const suffix = String(input).trim().toLowerCase();
    if (suffix.length === 0) {
      return suffix;
    }
    if (suffix !== Suffix.linuxdo_space) {
      return suffix;
    }

    const ownerUsername = (this.ownerUsername ?? "").trim().toLowerCase();
    if (ownerUsername.length === 0) {
      throw new StreamError("stream bootstrap did not provide owner_username required to resolve Suffix.linuxdo_space");
    }
    return `${ownerUsername}-mail.${suffix}`;
  }
}

async function parseMailEvent(payload: Record<string, unknown>): Promise<ParsedEnvelope> {
  const recipients = Array.isArray(payload.original_recipients)
    ? payload.original_recipients.map((item) => String(item).trim().toLowerCase()).filter((item) => item.length > 0)
    : [];
  const rawMessageBase64 = String(payload.raw_message_base64 ?? "").trim();
  if (rawMessageBase64.length === 0) {
    throw new StreamError("mail event did not include raw_message_base64");
  }
  if (!isStrictBase64(rawMessageBase64)) {
    throw new StreamError("mail event contained invalid base64 message data");
  }
  const rawBytes = Buffer.from(rawMessageBase64, "base64");

  const parsed = (await simpleParser(rawBytes)) as ParsedMailLike;
  const headers = mapHeaders(parsed.headerLines);
  const fromHeader = firstHeader(headers, "from");
  const toHeader = firstHeader(headers, "to");
  const ccHeader = firstHeader(headers, "cc");
  const replyToHeader = firstHeader(headers, "reply-to");

  return {
    sender: String(payload.original_envelope_from ?? "").trim(),
    recipients,
    receivedAt: parseIsoDate(String(payload.received_at ?? "").trim()),
    subject: parsed.subject ?? "",
    messageId: parsed.messageId ?? null,
    date: parsed.date ?? null,
    fromHeader,
    toHeader,
    ccHeader,
    replyToHeader,
    fromAddresses: flattenAddresses(parsed.from),
    toAddresses: flattenAddresses(parsed.to),
    ccAddresses: flattenAddresses(parsed.cc),
    replyToAddresses: flattenAddresses(parsed.replyTo),
    text: parsed.text ?? "",
    html: typeof parsed.html === "string" ? parsed.html : "",
    headers,
    raw: rawBytes.toString("utf-8"),
    rawBytes: rawBytes,
    parsed
  };
}

function mapHeaders(lines: ReadonlyArray<{ key: string; line: string }> | undefined): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (lines === undefined) {
    return headers;
  }
  for (const line of lines) {
    const key = line.key.toLowerCase();
    if (headers[key] === undefined) {
      headers[key] = line.line;
    }
  }
  return headers;
}

function firstHeader(headers: Readonly<Record<string, string>>, key: string): string {
  return headers[key] ?? "";
}

function flattenAddresses(value: AddressLike | undefined): readonly string[] {
  const list = value?.value ?? [];
  const result: string[] = [];
  for (const item of list) {
    if (typeof item.address !== "string") {
      continue;
    }
    const normalized = item.address.trim().toLowerCase();
    if (normalized.length > 0) {
      result.push(normalized);
    }
  }
  return result;
}

function parseIsoDate(value: string): Date {
  if (value.length === 0) {
    throw new StreamError("mail event timestamp was empty");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StreamError(`invalid mail event timestamp: ${value}`);
  }
  return date;
}

function projectMessage(envelope: ParsedEnvelope, address: string): MailMessage {
  return {
    address,
    sender: envelope.sender,
    recipients: envelope.recipients,
    receivedAt: envelope.receivedAt,
    subject: envelope.subject,
    messageId: envelope.messageId,
    date: envelope.date,
    fromHeader: envelope.fromHeader,
    toHeader: envelope.toHeader,
    ccHeader: envelope.ccHeader,
    replyToHeader: envelope.replyToHeader,
    fromAddresses: envelope.fromAddresses,
    toAddresses: envelope.toAddresses,
    ccAddresses: envelope.ccAddresses,
    replyToAddresses: envelope.replyToAddresses,
    text: envelope.text,
    html: envelope.html,
    headers: envelope.headers,
    raw: envelope.raw,
    rawBytes: envelope.rawBytes,
    parsed: envelope.parsed
  };
}

function matchesBinding(binding: MailBinding, localPart: string): boolean {
  if (binding.mode === "exact") {
    return binding.prefix === localPart;
  }
  const regex = binding.regex;
  if (regex === null) {
    return false;
  }
  regex.lastIndex = 0;
  const match = regex.exec(localPart);
  return match !== null && match[0] === localPart;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new ValueError("baseUrl must not be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValueError("baseUrl must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValueError("baseUrl must use http or https");
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.trim().toLowerCase();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost");
    if (!isLocal) {
      throw new ValueError("non-local baseUrl must use https");
    }
  }
  return trimmed;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function arraysEqual(left: readonly string[] | null, right: readonly string[]): boolean {
  if (left === null || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function isStrictBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return false;
  }
  return Buffer.from(normalized, "base64").toString("base64") === normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
