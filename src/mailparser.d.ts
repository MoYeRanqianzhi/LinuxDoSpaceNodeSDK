declare module "mailparser" {
  export function simpleParser(input: Uint8Array | Buffer): Promise<unknown>;
}
