/**
 * Node's fetch reports every network failure as `TypeError: fetch failed`; the actionable detail
 * (DNS, refused, TLS, timeout) is only in `error.cause`. Provider surfaces show the result to an
 * operator, so build a message that names the host and the actual cause.
 */
export function describeProviderFailure(error: unknown, url: string, timeoutMs?: number): string {
  const host = hostOf(url);
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code =
    typeof (cause as { code?: unknown } | null)?.code === "string"
      ? ((cause as { code: string }).code)
      : "";
  const name = error instanceof Error ? error.name : "";

  if (name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
    const seconds = timeoutMs ? Math.round(timeoutMs / 1000) : null;
    return `Provider ${host} tidak merespons${seconds ? ` dalam ${seconds} detik` : ""}.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Host ${host} tidak ditemukan. Periksa Base URL provider.`;
  }
  if (code === "ECONNREFUSED") return `Koneksi ke ${host} ditolak.`;
  if (code === "ECONNRESET") return `Koneksi ke ${host} terputus.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Host ${host} tidak dapat dijangkau dari server.`;
  }
  if (code.startsWith("CERT_") || code.startsWith("ERR_TLS_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `Sertifikat TLS ${host} tidak valid (${code}).`;
  }

  const detail =
    code.length > 0
      ? code
      : cause instanceof Error && cause.message !== (error instanceof Error ? error.message : "")
        ? cause.message
        : "";
  return `Tidak dapat menghubungi ${host}${detail.length > 0 ? ` (${detail})` : ""}.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
