import { operatorKey } from "./permitIngest.js";

/** Normalized key for soft company-name matching (reuses the dedupe normalizer). */
export const companyKey = (name) => operatorKey(name || "");

/** Build a Set of normalized company keys from rows via a name accessor. */
export function crossRefIndex(rows, getName) {
  const s = new Set();
  for (const r of rows || []) {
    const k = companyKey(getName(r));
    if (k) s.add(k);
  }
  return s;
}
