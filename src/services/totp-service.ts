import { eq } from "drizzle-orm";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";

import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { UserRow } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto/encryption.js";
import { validation } from "../http/errors.js";

const ISSUER = "Rupakarsa";

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({ secret, token: token.trim() });
    return result.valid === true;
  } catch {
    return false;
  }
}

/**
 * The secret is stored encrypted and stays inactive until the first valid code is posted back, so
 * a failed enrolment never locks the account behind a QR the user did not scan.
 */
export async function enrollTotp(user: UserRow): Promise<TotpEnrollment> {
  const secret = generateSecret();
  const otpauthUrl = generateURI({
    secret,
    label: user.email,
    issuer: ISSUER,
    period: 30,
    digits: 6,
    algorithm: "sha1",
  });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });

  await db
    .update(users)
    .set({ totpSecretEncrypted: encryptSecret(secret), totpEnabled: false })
    .where(eq(users.id, user.id));

  return { secret, otpauthUrl, qrDataUrl };
}

export async function activateTotp(user: UserRow, token: string): Promise<void> {
  if (user.totpSecretEncrypted.length === 0) {
    throw validation("Mulai enrol 2FA terlebih dahulu.");
  }
  const secret = decryptSecret(user.totpSecretEncrypted);
  if (!(await verifyTotpCode(secret, token))) {
    throw validation("Token verifikasi 2FA tidak valid.");
  }
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
}

export async function disableTotp(user: UserRow, token: string): Promise<void> {
  if (!user.totpEnabled) return;
  const secret = decryptSecret(user.totpSecretEncrypted);
  if (!(await verifyTotpCode(secret, token))) {
    throw validation("Token verifikasi 2FA tidak valid.");
  }
  await db
    .update(users)
    .set({ totpEnabled: false, totpSecretEncrypted: "" })
    .where(eq(users.id, user.id));
}
