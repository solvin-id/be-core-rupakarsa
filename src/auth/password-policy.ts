import { validation } from "../http/errors.js";

export const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{10,72}$/;
export const PASSWORD_MESSAGE = "Password minimal 10 karakter dan harus memuat huruf dan angka.";

export function assertPasswordPolicy(value: string): void {
  if (!PASSWORD_PATTERN.test(value)) throw validation(PASSWORD_MESSAGE);
}
