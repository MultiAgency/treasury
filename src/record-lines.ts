import { readFileSync } from "node:fs";
import type { z } from "zod";

/** A damaged record is unavailable evidence, including a torn final append. Never expose its contents. */
export function readRecordLines<T>(path: string, schema: z.ZodType<T>): T[] {
  return readFileSync(path, "utf8").split("\n").flatMap((text, index) => {
    if (!text.trim()) return [];
    try {
      return [schema.parse(JSON.parse(text))];
    } catch {
      throw new Error(`Invalid record in ${path} at line ${index + 1}; history unavailable. Preserve the file and restore from verified records before retrying.`);
    }
  });
}
