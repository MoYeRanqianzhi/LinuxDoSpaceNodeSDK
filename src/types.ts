/**
 * Suffix defines known LinuxDoSpace mailbox root suffixes.
 */
export enum Suffix {
  linuxdo_space = "linuxdo.space"
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
  suffix: Suffix | string;
  prefix?: string;
  pattern?: string | RegExp;
  allowOverlap?: boolean;
}
