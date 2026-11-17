import { AppError } from "../http/errors.js";

/** Sleeps for `ms`, but rejects as soon as the render signal aborts. */
export async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AppError(504, "PROVIDER_TIMEOUT", "Render melewati batas waktu."));
      },
      { once: true },
    );
  });
}
