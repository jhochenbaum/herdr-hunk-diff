import { parse } from "smol-toml";

export interface Binding {
  key: string;
  action: string;
  description: string;
}

export const PLUGIN_ID = "jhochenbaum.hunkdiff";
const BEGIN = `# BEGIN ${PLUGIN_ID} — managed by \`setup-keys\`; edit via the plugin, not by hand`;
const END = `# END ${PLUGIN_ID}`;

/** Small default set; setup skips keys already bound by the user. */
export const DEFAULT_BINDINGS: Binding[] = [
  {
    key: "prefix+shift+h",
    action: `${PLUGIN_ID}.review`,
    description: "hunk: review changes",
  },
  {
    key: "prefix+shift+s",
    action: `${PLUGIN_ID}.send-review`,
    description: "hunk: send review to agent",
  },
  {
    key: "prefix+shift+c",
    action: `${PLUGIN_ID}.review:commit`,
    description: "hunk: review the last commit",
  },
  {
    key: "prefix+shift+a",
    action: `${PLUGIN_ID}.review:staged`,
    description: "hunk: review staged changes",
  },
];

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses both Herdr keybinding forms. Invalid TOML throws rather than claiming all keys are free. */
export function takenKeys(configText: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = parse(configText);
  } catch (err) {
    throw new ConfigParseError(err instanceof Error ? err.message : String(err));
  }

  const keys = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== "") keys.add(value);
  };

  const table = isTable(parsed) ? parsed.keys : undefined;
  if (!isTable(table)) return keys;

  // Count a single table too, even though Herdr normally expects an array of tables.
  const commands = table.command;
  for (const entry of Array.isArray(commands) ? commands : [commands]) {
    if (isTable(entry)) add(entry.key);
  }

  for (const [field, value] of Object.entries(table)) {
    if (field === "prefix" || field === "command") continue;
    add(value);
  }

  return keys;
}

export function detectConflicts(configText: string, proposed: Binding[]): string[] {
  const taken = takenKeys(configText);
  return proposed.filter((b) => taken.has(b.key)).map((b) => b.key);
}

export function buildKeysBlock(bindings: Binding[]): string {
  const entries = bindings
    .map(
      (b) =>
        `[[keys.command]]\nkey = "${b.key}"\ntype = "plugin_action"\ncommand = "${b.action}"\ndescription = "${b.description}"`,
    )
    .join("\n\n");
  return `${BEGIN}\n${entries}\n${END}\n`;
}

export function stripKeysBlock(configText: string): string {
  const start = configText.indexOf(BEGIN);
  if (start === -1) return configText;
  const endMarker = configText.indexOf(END, start);
  if (endMarker === -1) return configText;
  const end = endMarker + END.length;
  const before = configText.slice(0, start);
  const after = configText.slice(end);
  return (before.replace(/\n+$/, "\n") + after.replace(/^\n+/, "")).replace(/\n{3,}/g, "\n\n");
}
