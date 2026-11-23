import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  renameSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fail } from "../http/errors.js";
type Keyring = {
  version: 1;
  active: string;
  keys: Record<string, string>;
  digest: string;
};
export type Cipher = {
  version: 1;
  keyId: string;
  nonce: string;
  tag: string;
  data: string;
};
const newKey = () => randomBytes(32).toString("base64");
const keyId = () => "k_" + randomBytes(12).toString("hex");
export class CredentialVault {
  private constructor(
    readonly file: string,
    private ring: Keyring,
  ) {}
  static create(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const id = keyId(),
      ring: Keyring = {
        version: 1,
        active: id,
        keys: { [id]: newKey() },
        digest: newKey(),
      };
    const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(temporary, JSON.stringify(ring), { flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      unlinkSync(temporary);
    }
    return CredentialVault.load(file);
  }
  static load(file: string) {
    let ring: Keyring;
    try {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        fail(503, "credential_key_permissions");
      ring = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        fail(503, "credential_key_missing");
      throw e;
    }
    if (
      ring!.version !== 1 ||
      !ring!.keys?.[ring!.active] ||
      Buffer.from(ring!.digest || "", "base64").length !== 32 ||
      Object.values(ring!.keys).some(
        (key) =>
          typeof key !== "string" || Buffer.from(key, "base64").length !== 32,
      )
    )
      fail(503, "credential_key_invalid");
    return new CredentialVault(file, ring!);
  }
  digest(value: string) {
    return createHmac("sha256", Buffer.from(this.ring.digest, "base64"))
      .update(value)
      .digest();
  }
  requestKey() {
    return this.digest("campus-command-input-v1");
  }
  hasKey(id: unknown) {
    return typeof id === "string" && Object.hasOwn(this.ring.keys, id);
  }
  private aad(id: string, field: string, key: string) {
    return Buffer.from(["campus", 1, id, field, key].join(":"));
  }
  encrypt(id: string, field: string, value: string): Cipher | null {
    if (!value) return null;
    const nonce = randomBytes(12),
      keyId = this.ring.active,
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(this.ring.keys[keyId], "base64"),
        nonce,
      );
    cipher.setAAD(this.aad(id, field, keyId));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      version: 1,
      keyId,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  decrypt(id: string, field: string, value: Cipher | null): string {
    if (value === null) return "";
    if (!value || value.version !== 1) fail(503, "credential_integrity");
    const key = this.ring.keys[value.keyId];
    if (!key) fail(503, "credential_key_missing");
    try {
      const nonce = Buffer.from(value.nonce, "base64"),
        tag = Buffer.from(value.tag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) throw Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "base64"),
        nonce,
      );
      cipher.setAAD(this.aad(id, field, value.keyId));
      cipher.setAuthTag(tag);
      return Buffer.concat([
        cipher.update(Buffer.from(value.data, "base64")),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      fail(503, "credential_integrity");
    }
  }
  rotate() {
    // Retain old keys so existing encrypted backups remain recoverable.
    const id = keyId();
    this.ring = {
      ...this.ring,
      active: id,
      keys: { ...this.ring.keys, [id]: newKey() },
    };
    const temporary = this.file + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.ring), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, this.file);
    return id;
  }
}

export function preflightCampusKeys(
  file: string,
  rows: {
    id: string;
    account_cipher: Cipher | null;
    password_cipher: Cipher | null;
  }[],
) {
  if (!rows.some((row) => row.account_cipher || row.password_cipher)) return;
  const vault = CredentialVault.load(file);
  for (const row of rows) {
    vault.decrypt(row.id, "account", row.account_cipher);
    vault.decrypt(row.id, "password", row.password_cipher);
  }
}
