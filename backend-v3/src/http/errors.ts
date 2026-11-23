export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function fail(status: number, code: string): never {
  throw new ApiError(status, code);
}
export function found<T>(value: T | undefined | null): T {
  if (value === null || value === undefined) fail(404, "not_found");
  return value;
}
