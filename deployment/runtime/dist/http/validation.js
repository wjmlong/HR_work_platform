import { z } from "zod";
import { fail } from "./errors.js";
export { z };
export const uuid = z.uuid();
export const version = z.number().int().positive();
export const text = z.string().trim().min(1).max(1000);
export function parse(schema, value) {
    const r = schema.safeParse(value);
    if (!r.success)
        fail(422, "invalid_input");
    return r.data;
}
//# sourceMappingURL=validation.js.map