import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Compares an ESM module with the process entrypoint. Realpath handles symlinked plugin roots and
 * pathToFileURL handles URL escaping; unreadable paths are compared as given.
 */
export function isMainModule(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (!entry) return false;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    // Compare the unresolved entry below.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}
