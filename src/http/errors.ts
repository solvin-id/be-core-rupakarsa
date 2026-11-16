export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function unauthorized(message = "Sesi tidak valid. Silakan masuk kembali."): AppError {
  return new AppError(401, "UNAUTHENTICATED", message);
}

export function forbidden(message: string): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFound(message: string): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function conflict(message: string): AppError {
  return new AppError(409, "CONFLICT", message);
}

export function validation(message: string): AppError {
  return new AppError(400, "VALIDATION_ERROR", message);
}
