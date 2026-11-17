import { describe, expect, it } from "vitest";

import { describeProviderFailure } from "../../src/services/provider-failure.js";

/** Node's fetch hides DNS/TLS detail in `cause`; operators only get what we put in the message. */
function undiciFailure(cause: unknown): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = cause;
  return error;
}

describe("describeProviderFailure", () => {
  it("names the host when DNS resolution fails", () => {
    const message = describeProviderFailure(
      undiciFailure(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })),
      "https://api.example.test/v1/models",
    );
    expect(message).toBe("Host api.example.test tidak ditemukan. Periksa Base URL provider.");
  });

  it("reports timeouts with the configured budget", () => {
    const error = undiciFailure(Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }));
    expect(describeProviderFailure(error, "https://slow.example.test/v1/models", 15_000)).toBe(
      "Provider slow.example.test tidak merespons dalam 15 detik.",
    );

    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    expect(describeProviderFailure(abort, "https://slow.example.test/v1/models", 30_000)).toBe(
      "Provider slow.example.test tidak merespons dalam 30 detik.",
    );
  });

  it("distinguishes refused connections from certificate problems", () => {
    const refused = undiciFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(describeProviderFailure(refused, "http://10.0.0.5:8080/v1")).toBe(
      "Koneksi ke 10.0.0.5:8080 ditolak.",
    );

    const tls = undiciFailure(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }));
    expect(describeProviderFailure(tls, "https://expired.example.test/v1")).toBe(
      "Sertifikat TLS expired.example.test tidak valid (CERT_HAS_EXPIRED).",
    );
  });

  it("falls back to the cause message and tolerates a bare failure", () => {
    expect(describeProviderFailure(undiciFailure(new Error("socket hang up")), "https://x.test/v1")).toBe(
      "Tidak dapat menghubungi x.test (socket hang up).",
    );
    expect(describeProviderFailure(new TypeError("fetch failed"), "https://x.test/v1")).toBe(
      "Tidak dapat menghubungi x.test.",
    );
  });
});
