export type MailTemplate = "ACCOUNT_CREATED" | "PASSWORD_RESET" | "RENDER_COMPLETED";

export interface RenderedMail {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

function layout(title: string, lines: string[], action?: { label: string; url: string }): string {
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${line}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0;"><a href="${action.url}" style="background:#f04e23;color:#ffffff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600;">${action.label}</a></p>
       <p style="margin:0;color:#6b7280;font-size:12px;">${action.url}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#f7f6f3;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;">
    <p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;margin:0 0 16px 0;">Rupakarsa</p>
    <h1 style="font-size:20px;margin:0 0 20px 0;color:#111827;">${title}</h1>
    ${paragraphs}
    ${button}
  </div>
</body></html>`;
}

export function renderTemplate(template: MailTemplate, data: Record<string, string>): RenderedMail {
  switch (template) {
    case "ACCOUNT_CREATED":
      return {
        subject: "Akun Rupakarsa Anda sudah aktif",
        bodyHtml: layout(
          "Akun Rupakarsa dibuat",
          [
            `Halo ${data.fullName ?? "Kreator"},`,
            `Akun Anda terdaftar dengan email <strong>${data.email ?? ""}</strong>.`,
            `Password: <strong>${data.password ?? ""}</strong>`,
            "Ganti password setelah masuk pertama kali.",
          ],
          { label: "Masuk ke Rupakarsa", url: data.loginUrl ?? "https://rupakarsa.solvin.id/login" },
        ),
        bodyText: [
          `Halo ${data.fullName ?? "Kreator"},`,
          `Akun Rupakarsa terdaftar dengan email ${data.email ?? ""}.`,
          `Password: ${data.password ?? ""}`,
          `Masuk: ${data.loginUrl ?? "https://rupakarsa.solvin.id/login"}`,
        ].join("\n"),
      };
    case "PASSWORD_RESET":
      return {
        subject: "Reset password Rupakarsa",
        bodyHtml: layout(
          "Reset password",
          [
            "Kami menerima permintaan reset password untuk akun ini.",
            "Tautan berlaku 60 menit. Abaikan email ini bila Anda tidak meminta reset.",
          ],
          { label: "Atur password baru", url: data.resetUrl ?? "" },
        ),
        bodyText: `Reset password: ${data.resetUrl ?? ""} (berlaku 60 menit)`,
      };
    case "RENDER_COMPLETED":
      return {
        subject:
          data.status === "FAILED" ? "Render gagal, token dikembalikan" : "Render Anda sudah selesai",
        bodyHtml: layout(
          data.status === "FAILED" ? "Render gagal" : "Render selesai",
          [
            `Model: <strong>${data.modelName ?? ""}</strong>`,
            data.status === "FAILED"
              ? `Alasan: ${data.errorMessage ?? "Render gagal."}`
              : "Hasil tersimpan di folder proyek dan halaman Penyimpanan.",
          ],
          data.status === "FAILED" ? undefined : { label: "Buka studio", url: data.studioUrl ?? "" },
        ),
        bodyText:
          data.status === "FAILED"
            ? `Render ${data.modelName ?? ""} gagal. ${data.errorMessage ?? ""}`
            : `Render ${data.modelName ?? ""} selesai. ${data.studioUrl ?? ""}`,
      };
  }
}
