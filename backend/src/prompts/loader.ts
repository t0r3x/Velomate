import fs from 'fs';
import path from 'path';

/**
 * Prompt text lives in the .md files next to this module, not in the services.
 *
 *   shared/  blocks both modes use (workout types, calibration, scoring, how to read the data)
 *   plan/    the 14-day plan: system instruction, per-call athlete turn, pinned-day lines
 *   free/    free training mode: same shape, one dateless suggestion
 *
 * A file is sent as written. {{NAME}} is the only template syntax: the caller fills every
 * placeholder, and renderPrompt() throws on a placeholder without a value AND on a value without
 * a placeholder, so renaming one on either side fails loudly instead of silently dropping data
 * from the prompt. Substitution is a single pass, so text inserted into a placeholder (a goal the
 * athlete typed, another block) is never itself expanded.
 *
 * Files are normalised on read (BOM stripped, CRLF -> LF, one trailing newline removed). Git on
 * Windows checks them out with CRLF, and the system instructions must be byte-identical on every
 * machine: they are the cacheable prefix.
 *
 * Build: tsc does not copy non-TS files, so `npm run build` runs scripts/copy-prompts.js to put
 * them in dist/prompts. Both the Docker image and the Electron package ship dist/ as a whole.
 */
const cache = new Map<string, string>();

export const loadPrompt = (name: string): string => {
  let text = cache.get(name);
  if (text === undefined) {
    text = fs.readFileSync(path.join(__dirname, `${name}.md`), 'utf8')
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '');
    cache.set(name, text);
  }
  return text;
};

export const renderPrompt = (name: string, vars: Record<string, string | number> = {}): string => {
  const used = new Set<string>();
  const text = loadPrompt(name).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt "${name}" uses {{${key}}} but no value was supplied`);
    used.add(key);
    return String(vars[key]);
  });
  const unused = Object.keys(vars).filter(k => !used.has(k));
  if (unused.length > 0) throw new Error(`Prompt "${name}" has no placeholder for: ${unused.join(', ')}`);
  return text;
};
