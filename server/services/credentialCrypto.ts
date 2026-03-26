import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const KEY_ENV = "CREDENTIALS_ENCRYPTION_KEY";
const PREFIX = "enc:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function getKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(`Missing ${KEY_ENV}. Set a 32-byte base64 or hex key.`);
  }

  // Support base64 and hex
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(`${KEY_ENV} must decode to ${KEY_BYTES} bytes.`);
  }
  return key;
}

export function encryptSecret(plain?: string | null): string | null | undefined {
  if (!plain) return plain;
  if (plain.startsWith(PREFIX)) return plain;

  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const packed = Buffer.concat([iv, tag, ciphertext]).toString("base64");
  return `${PREFIX}${packed}`;
}

export function decryptSecret(value?: string | null): string | null | undefined {
  if (!value) return value;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext

  const key = getKey();
  const packed = Buffer.from(value.slice(PREFIX.length), "base64");
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Invalid encrypted secret payload.");
  }

  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

