import { promises as fs } from 'fs';
import * as path from 'path';

export interface FileRestore {
  path: string;
  // Content before the turn; null when Claude created the file during or after it.
  original: string | null;
}

interface Change {
  time: number;
  path: string;
  original: string | null | undefined;
}

/** File changes Claude Code recorded in a transcript: the file content as it was right before each Edit or Write. */
export function changesIn(text: string): { changes: Change[]; turnTimes: Map<string, number> } {
  const changes: Change[] = [];
  const turnTimes = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) {
      continue;
    }
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const time = Date.parse(row.timestamp) || 0;
    if (row.uuid) {
      turnTimes.set(String(row.uuid), time);
    }
    const r = row.toolUseResult;
    if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') {
      continue;
    }
    // Write of a new file says type "create"; Edit and overwrite carry the previous text in originalFile.
    const original = r.type === 'create' ? null : typeof r.originalFile === 'string' ? r.originalFile : undefined;
    changes.push({ time, path: r.filePath, original });
  }
  return { changes, turnTimes };
}

/**
 * What to write back to undo everything Claude changed from a prompt onwards: for each file, its content before the
 * first change at or after `since`. Files whose earlier content wasn't recorded are listed in `unknown`.
 */
export function restorePlan(changes: Change[], since: number): { restores: FileRestore[]; unknown: string[] } {
  const firstByPath = new Map<string, Change>();
  for (const c of [...changes].sort((a, b) => a.time - b.time)) {
    if (c.time >= since && !firstByPath.has(c.path)) {
      firstByPath.set(c.path, c);
    }
  }
  const restores: FileRestore[] = [];
  const unknown: string[] = [];
  for (const c of firstByPath.values()) {
    if (c.original === undefined) {
      unknown.push(c.path);
    } else {
      restores.push({ path: c.path, original: c.original });
    }
  }
  return { restores, unknown };
}

/** Reads the session's transcripts (main first) and plans an undo back to before the prompt with uuid `turnId`. */
export async function planUndo(files: string[], turnId: string) {
  const all: Change[] = [];
  let since: number | undefined;
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { changes, turnTimes } = changesIn(text);
    all.push(...changes);
    since ??= turnTimes.get(turnId);
  }
  return since === undefined ? null : restorePlan(all, since);
}

/** True when `p` is inside one of `roots` after resolving symlinks, so an undo can't write through a link to outside. */
export async function insideRoots(p: string, roots: string[]): Promise<boolean> {
    const real = async (x: string): Promise<string> => {
        try {
            return await fs.realpath(x);
        } catch {
            // Not there (deleted since); resolve the nearest existing parent instead.
            const parent = path.dirname(x);
            return parent === x ? x : path.join(await real(parent), path.basename(x));
        }
    };
    const target = await real(path.resolve(p));
    for (const root of roots) {
        const rel = path.relative(await real(root), target);
        if (rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) {
            return true;
        }
    }
    return false;
}
