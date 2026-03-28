/**
 * Suffix defines known LinuxDoSpace mailbox namespace suffixes.
 *
 * `Suffix.linuxdo_space` is semantic rather than literal: bindings resolve it
 * to the current owner's canonical `-mail` namespace after the stream `ready`
 * event provides `owner_username`.
 */
export enum Suffix {
  linuxdo_space = "linuxdo.space"
}

/**
 * SemanticSuffix models one first-party semantic mailbox suffix together with
 * one optional dynamic `-mail<fragment>` extension.
 */
export class SemanticSuffix {
  public readonly base: Suffix;
  public readonly mailSuffixFragment: string;

  public constructor(base: Suffix, fragment: string) {
    this.base = base;
    this.mailSuffixFragment = normalizeMailSuffixFragment(fragment);
  }
}

/**
 * Namespace helpers attached to the public `Suffix` enum.
 */
export namespace Suffix {
  /**
   * withSuffix() is the Node.js natural equivalent of
   * `Suffix.linuxdo_space.with_suffix("foo")` from the Python SDK.
   */
  export function withSuffix(base: Suffix, fragment: string): SemanticSuffix {
    return new SemanticSuffix(base, fragment);
  }
}

/**
 * MailMessage is the normalized message model exposed by the SDK.
 * All fields are stable and intended for direct consumer usage.
 */
export interface MailMessage {
  address: string;
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

/**
 * ClientOptions configures one SDK client instance.
 */
export interface ClientOptions {
  token: string;
  baseUrl?: string;
  connectTimeoutMs?: number;
  streamTimeoutMs?: number;
  reconnectDelayMs?: number;
}

/**
 * MailBindingSpec is a declarative spec object used by bindMany().
 */
export interface MailBindingSpec {
  suffix: Suffix | SemanticSuffix | string;
  prefix?: string;
  pattern?: string | RegExp;
  allowOverlap?: boolean;
}

function normalizeMailSuffixFragment(raw: string): string {
  const value = String(raw).trim().toLowerCase();
  if (value.length === 0) {
    return "";
  }

  const normalizedParts: string[] = [];
  let lastWasDash = false;
  for (const character of value) {
    const isAlpha = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (isAlpha || isDigit) {
      normalizedParts.push(character);
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash) {
      normalizedParts.push("-");
      lastWasDash = true;
    }
  }

  const normalized = normalizedParts.join("").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new TypeError("mail suffix fragment does not contain any valid dns characters");
  }
  if (normalized.includes(".")) {
    throw new TypeError("mail suffix fragment must stay inside one dns label");
  }
  if (normalized.length > 48) {
    throw new TypeError("mail suffix fragment must be 48 characters or fewer");
  }
  return normalized;
}
