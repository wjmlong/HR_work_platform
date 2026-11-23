const marker = "__recruit_v3_lossless_json";
export function encodeJSON(value: unknown): string {
  const json = JSON.stringify(value);
  return /\\u(?:0000|d[89a-f][0-9a-f]{2})/i.test(json)
    ? JSON.stringify({ [marker]: Buffer.from(json, "utf8").toString("base64") })
    : json;
}
export function decodeJSON<T = any>(value: any): T {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value[marker] === "string"
    ? JSON.parse(Buffer.from(value[marker], "base64").toString("utf8"))
    : value;
}
