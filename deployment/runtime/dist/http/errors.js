export class ApiError extends Error {
    statusCode;
    code;
    constructor(statusCode, code) {
        super(code);
        this.statusCode = statusCode;
        this.code = code;
    }
}
export function fail(status, code) {
    throw new ApiError(status, code);
}
export function found(value) {
    if (value === null || value === undefined)
        fail(404, "not_found");
    return value;
}
//# sourceMappingURL=errors.js.map