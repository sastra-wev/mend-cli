// mend: one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four
// formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
// format, and text-editor tool calls as JSON. mend reads all four, finds the lines each edit names
// at the first of three matching tiers (exact, trailing-whitespace-blind, indentation-blind), and
// changes every file or none. SPEC.md is the whole contract; this file is the whole tool.
//
// Node 22, the standard library alone. Run it as:
//
//     node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// with the working directory as the root of the tree. The last lines of this file hand a grading
// trial over to runner.ts when MAKEFUN_ENV_URL is set; that hand-over, and runner.ts itself, are
// the kit's and are kept as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A failure of the whole run: exit 2, and this is the one line printed. */
class Abort {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed. Exit 1 collects one of these per failed edit, in the patch's order. */
class EditError {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Text, files and paths (SPEC.md section 3)
// ---------------------------------------------------------------------------

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at \n, one trailing \r removed from each, and no empty piece
 *  after a final \n. Patch line numbers count these lines from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no backslash, and none of its
 *  /-separated segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafePath(p)) throw new EditError('unsafe', p);
}

interface FileParts {
  lines: string[];
  /** The file's own line break: CRLF when its first line feed follows a carriage return. */
  br: string;
  /** Whether the file's text ends with its line break. */
  tail: boolean;
}

/** Split a file's text into lines at its own line break. An empty file has no lines and does not
 *  end with a line break. */
function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, tail: false };
  const lines = text.split(br);
  const tail = text.endsWith(br);
  if (tail) lines.pop();
  return { lines, br, tail };
}

/** Write lines back with the file's own line break, and a final one exactly when `tail` says so.
 *  A file of no lines is written empty. */
function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.tail ? parts.br : '');
}

// ---------------------------------------------------------------------------
// The tree the edits work on (SPEC.md section 10)
// ---------------------------------------------------------------------------

type Edit = (tree: Tree) => void;

/** The tree as the edits leave it. `now` holds every path an edit has touched (null: the file is
 *  gone); any other path is read from disk the first time it is looked at and remembered as its
 *  original. Successful move edits are remembered in `moves` so the report can print an R line. */
class Tree {
  readonly now = new Map<string, string | null>();
  private readonly before = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  read(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  write(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

/** The text of a file an edit changes, or the edit fails `missing`. */
function needFile(tree: Tree, p: string): string {
  const t = tree.read(p);
  if (t === null) throw new EditError('missing', p);
  return t;
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => trimTrail(s.replace(/^[ \t]+/, ''));
const TIERS: Array<(s: string) => string> = [(s) => s, trimTrail, trimBoth];
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

interface Found {
  tier: number;
  spots: number[];
}

/** The occurrences of `old` in `lines`, at or after `from`, at the first tier that has any.
 *  With `endAtLast`, only occurrences that end at the file's last line count. Occurrences may
 *  overlap. Null when no tier has one. */
function findLines(lines: string[], old: string[], strict: boolean, from = 0, endAtLast = false): Found | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const norm = TIERS[tier]!;
    const want = old.map(norm);
    const spots: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
      if (endAtLast && i + old.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (norm(lines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) spots.push(i);
    }
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier that has
 *  one; -1 when there is none. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const norm = TIERS[tier]!;
    const want = norm(anchor);
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (norm(lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** One line of a matched block: a context line (in both the old and the new block), a line only
 *  the old block has, or a line only the new block has. */
interface SegLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** The lines that replace the match at `at`. A context line is written as the file's own matched
 *  line, never the patch's. At tier 2 every other new line is re-indented: F, the leading spaces
 *  and tabs of the file's first matched line, replaces P, those of the old block's first line, at
 *  the head of any new line that is not blank and starts with P. */
function replacement(lines: string[], at: number, oldSeg: SegLine[], newSeg: SegLine[], tier: number): string[] {
  const ctxOffsets: number[] = [];
  oldSeg.forEach((e, i) => {
    if (e.kind === 'ctx') ctxOffsets.push(i);
  });
  const bigF = leadWs(lines[at] ?? '');
  const bigP = leadWs(oldSeg.length > 0 ? oldSeg[0]!.text : '');
  let seen = 0;
  const out: string[] = [];
  for (const e of newSeg) {
    if (e.kind === 'ctx') {
      out.push(lines[at + ctxOffsets[seen]!]!);
      seen += 1;
    } else if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(bigP)) {
      out.push(bigF + e.text.slice(bigP.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object as an Edit, or null when it is not one: a wrong command, or a missing or
 *  mistyped key, is a parse fault, and the caller reports it. Keys the section does not name are
 *  ignored. */
function jsonObjectEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(path);
      if (tree.read(path) !== null) throw new EditError('exists', path);
      tree.write(path, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      needSafe(path);
      const before = needFile(tree, path);
      // In a CRLF file the text and both strings are read with every \r\n as \n, and the result
      // is written back with \r\n. The match is exact; no tier applies.
      const crlf = splitFile(before).br === '\r\n';
      const flat = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = flat(before);
      const needle = flat(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', path);
      if (count > 1) throw new EditError('ambiguous', path);
      const at = text.indexOf(needle);
      const done = text.slice(0, at) + flat(newStr) + text.slice(at + needle.length);
      tree.write(path, crlf ? done.split('\n').join('\r\n') : done);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(path);
      const parts = splitFile(needFile(tree, path));
      if (at < 0 || at > parts.lines.length) throw new EditError('no-match', path);
      parts.lines.splice(at, 0, ...add);
      tree.write(path, joinFile(parts));
    };
  }

  return null;
}

/** The patch is one JSON array of edit objects, or JSON Lines with one edit object a line and
 *  blank lines ignored. A fault in array form is reported at the line where the array starts;
 *  in JSON Lines form, at the line that does not hold one valid edit object. */
function readJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Abort('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Abort(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Abort(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const e = jsonObjectEdit(item);
      if (e === null) throw new Abort(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let e: Edit | null = null;
    try {
      e = jsonObjectEdit(JSON.parse(line));
    } catch {
      e = null;
    }
    if (e === null) throw new Abort(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** A of the @@ -A[,B] +C[,D] @@ header: where the model thought the hunk goes. */
  a: number;
  body: SegLine[];
  /** Indexes into body of the lines a `\` line follows (as in `\ No newline at end of file`). */
  noEol: Set<number>;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  creates: boolean;
  deletes: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    creates: false,
    deletes: false,
    hunks: [],
  };
}

const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a --- or +++ line names: the text after the four characters, up to the first tab,
 *  with surrounding spaces removed, and a leading a/ or b/ removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Read the whole patch as sections and hunks, or throw the parse error the section names. */
function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Abort(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new Abort(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Abort(`error: parse ${i + 1}`);
      const body: SegLine[] = [];
      const fromEmpty: boolean[] = [];
      const noEol = new Set<number>();
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '' });
          fromEmpty.push(true);
          i += 1;
          continue;
        }
        const c = b.charAt(0);
        if (c === ' ') body.push({ kind: 'ctx', text: b.slice(1) });
        else if (c === '-') body.push({ kind: 'old', text: b.slice(1) });
        else if (c === '+') body.push({ kind: 'new', text: b.slice(1) });
        else if (c === '\\') {
          if (body.length > 0) noEol.add(body.length - 1);
          i += 1;
          continue;
        } else break;
        fromEmpty.push(false);
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && fromEmpty[fromEmpty.length - 1]) {
        body.pop();
        fromEmpty.pop();
      }
      sec.hunks.push({ a: Number(m[1]), body, noEol });
      continue;
    }

    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (sec === null) {
        // A --- line followed by a +++ line starts a section; any other --- line is prose.
        if (followed) {
          sec = newSection();
          sec.hasPair = true;
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[i + 1]!);
          sections.push(sec);
          i += 2;
        } else i += 1;
        continue;
      }
      if (sec.hunks.length === 0) {
        // Inside this section's header the pair must be whole, or the next line is the error.
        if (!followed) throw new Abort(`error: parse ${i + 2}`);
        if (sec.hasPair) {
          // A second pair is not part of this section's header: it starts the next section.
          sec = newSection();
          sections.push(sec);
        }
        sec.hasPair = true;
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      // After the hunks, a whole pair starts the next section; a lone --- line is prose.
      if (followed) {
        sec = newSection();
        sec.hasPair = true;
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sections.push(sec);
        i += 2;
      } else i += 1;
      continue;
    }

    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.creates = true;
      else if (line.startsWith('deleted file mode')) sec.deletes = true;
    }
    // Anything else, in a header or between sections, is ignored: index and mode lines, prose,
    // code fences.
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One section is one edit: a creation, a deletion, a move, or a change of one path. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    // The ---/+++ pair names the paths when there is one; rename from/to when there is not;
    // the diff --git paths when nothing else names one.
    let oldName: string | null;
    let newName: string | null;
    if (sec.hasPair) {
      oldName = sec.pairOld;
      newName = sec.pairNew;
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldName = sec.renameFrom;
      newName = sec.renameTo;
    } else {
      oldName = sec.gitOld;
      newName = sec.gitNew;
    }
    const creation = sec.creates || oldName === '/dev/null';
    const deletion = sec.deletes || newName === '/dev/null';

    if (creation) {
      const target = newName ?? '';
      needSafe(target);
      if (tree.read(target) !== null) throw new EditError('exists', target);
      // The file is the + lines of all its hunks, in order, written with LF breaks and a final
      // one unless a `\` line follows its last + line.
      const plus: string[] = [];
      let lastMarked = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, idx) => {
          if (e.kind === 'new') {
            plus.push(e.text);
            lastMarked = h.noEol.has(idx);
          }
        });
      }
      tree.write(target, plus.length === 0 ? '' : plus.join('\n') + (lastMarked ? '' : '\n'));
      return;
    }

    if (deletion) {
      const target = oldName ?? '';
      needSafe(target);
      if (tree.read(target) === null) throw new EditError('missing', target);
      tree.write(target, null);
      return;
    }

    const from = oldName ?? '';
    const to = newName ?? '';
    needSafe(from);
    needSafe(to);
    const before = tree.read(from);
    if (before === null) throw new EditError('missing', from);
    if (from !== to && tree.read(to) !== null) throw new EditError('exists', to);

    const parts = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oldSeg = h.body.filter((e) => e.kind !== 'new');
      const newSeg = h.body.filter((e) => e.kind !== 'old');
      if (oldSeg.length === 0) {
        // Nothing to find: N goes after the first A + d lines, or at the end when the file
        // has fewer.
        const at = Math.min(h.a + d, parts.lines.length);
        const atEnd = at === parts.lines.length;
        const adds = newSeg.map((e) => e.text);
        parts.lines.splice(at, 0, ...adds);
        if (atEnd) parts.tail = !lastLineMarked(h);
        d += adds.length;
        continue;
      }
      const found = findLines(parts.lines, oldSeg.map((e) => e.text), strict);
      if (found === null) throw new EditError('no-match', from);
      // Of the occurrences at the tier where O is found, take the one whose 0-based position
      // is nearest to A - 1 + d; of two equally near, the earlier.
      const aim = h.a - 1 + d;
      let at = found.spots[0]!;
      for (const s of found.spots) {
        if (Math.abs(s - aim) < Math.abs(at - aim)) at = s;
      }
      const seg = replacement(parts.lines, at, oldSeg, newSeg, found.tier);
      const touchesEnd = at + oldSeg.length === parts.lines.length;
      parts.lines.splice(at, oldSeg.length, ...seg);
      if (touchesEnd) parts.tail = !lastLineMarked(h);
      d += newSeg.length - oldSeg.length;
    }

    if (from === to) {
      tree.write(from, joinFile(parts));
    } else {
      tree.write(to, joinFile(parts));
      tree.write(from, null);
      tree.moves.push([from, to]);
    }
  };
}

/** Whether a `\` line follows the hunk's last context or + line: when it does, a file the hunk
 *  leaves at its end does not end with a line break. */
function lastLineMarked(h: Hunk): boolean {
  let last = -1;
  h.body.forEach((e, idx) => {
    if (e.kind !== 'old') last = idx;
  });
  return last >= 0 && h.noEol.has(last);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

/** Read the blocks in order. The path of a block is the nearest line before its SEARCH line,
 *  and after the previous block's REPLACE line, that is not blank and does not start with three
 *  backticks; a block with no such line takes the previous block's path, and the first block
 *  with none is a parse error at its SEARCH line, as is a SEARCH line with no ======= and then
 *  >>>>>>> REPLACE after it. Lines outside blocks are otherwise ignored. */
function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Abort(`error: parse ${searchAt + 1}`);

    let mid = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (mid < 0) throw new Abort(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let j = mid + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Abort(`error: parse ${searchAt + 1}`);

    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** One block is one edit: empty old lines create the file with the new lines; otherwise the old
 *  lines must occur at their tier exactly once, or the block fails ambiguous. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const oldSeg: SegLine[] = oldLines.map((text) => ({ kind: 'old', text }));
  const newSeg: SegLine[] = newLines.map((text) => ({ kind: 'new', text }));
  return (tree) => {
    needSafe(path);
    if (oldLines.length === 0) {
      if (tree.read(path) !== null) throw new EditError('exists', path);
      tree.write(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const parts = splitFile(needFile(tree, path));
    const found = findLines(parts.lines, oldLines, strict);
    if (found === null) throw new EditError('no-match', path);
    if (found.spots.length > 1) throw new EditError('ambiguous', path);
    const at = found.spots[0]!;
    const seg = replacement(parts.lines, at, oldSeg, newSeg, found.tier);
    parts.lines.splice(at, oldLines.length, ...seg);
    tree.write(path, joinFile(parts));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: SegLine[];
}

const V_HEADS: Array<readonly [string, string]> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'del'],
  ['*** Update File: ', 'upd'],
];

function vHead(line: string): { kind: string; path: string } | null {
  for (const [prefix, kind] of V_HEADS) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

/** The first non-blank line is *** Begin Patch and the last is *** End Patch; between them,
 *  sections start at the Add, Delete and Update File lines, blank lines between sections are
 *  ignored, and any other line is a parse error at its own line. */
function readV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Abort('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Abort(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Abort(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = vHead(lines[i]!);
    if (head === null) throw new Abort(`error: parse ${i + 1}`);
    const headerAt = i;
    i += 1;
    const raw: Array<{ line: string; at: number }> = [];
    while (i < last && vHead(lines[i]!) === null) {
      raw.push({ line: lines[i]!, at: i });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.line)) raw.pop();
    edits.push(v4aSection(head.kind, head.path, headerAt, raw, strict));
  }
  return edits;
}

function v4aSection(
  kind: string,
  path: string,
  headerAt: number,
  raw: Array<{ line: string; at: number }>,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { line, at } of raw) {
      if (line.startsWith('+')) fileLines.push(line.slice(1));
      else if (line === '') fileLines.push('');
      else throw new Abort(`error: parse ${at + 1}`);
    }
    return (tree) => {
      needSafe(path);
      if (tree.read(path) !== null) throw new EditError('exists', path);
      tree.write(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
    };
  }

  if (kind === 'del') {
    for (const { line, at } of raw) {
      if (isBlank(line)) continue;
      throw new Abort(`error: parse ${at + 1}`);
    }
    return (tree) => {
      needSafe(path);
      if (tree.read(path) === null) throw new EditError('missing', path);
      tree.write(path, null);
    };
  }

  // An Update File section: an optional *** Move to: as its first line, then chunks. A chunk
  // starts at an @@ line, or, for the first chunk, at a body line; *** End of File ends a chunk
  // and anchors it to the end of the file.
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closedChunk = false;
  let sawAny = false;
  for (const { line, at } of raw) {
    if (line.startsWith('*** Move to: ')) {
      if (sawAny) throw new Abort(`error: parse ${at + 1}`);
      moveTo = line.slice('*** Move to: '.length).trim();
      sawAny = true;
      continue;
    }
    sawAny = true;
    if (line.startsWith('@@')) {
      cur = { anchor: line.slice(2).trim() || null, eof: false, body: [] };
      chunks.push(cur);
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new Abort(`error: parse ${at + 1}`);
      cur.eof = true;
      cur = null;
      closedChunk = true;
      continue;
    }
    const c = line.charAt(0);
    if (line !== '' && c !== ' ' && c !== '-' && c !== '+') throw new Abort(`error: parse ${at + 1}`);
    if (cur === null) {
      if (chunks.length > 0 || closedChunk) throw new Abort(`error: parse ${at + 1}`);
      cur = { anchor: null, eof: false, body: [] };
      chunks.push(cur);
    }
    if (line === '') cur.body.push({ kind: 'ctx', text: '' });
    else if (c === ' ') cur.body.push({ kind: 'ctx', text: line.slice(1) });
    else if (c === '-') cur.body.push({ kind: 'old', text: line.slice(1) });
    else cur.body.push({ kind: 'new', text: line.slice(1) });
  }
  if (chunks.length === 0 && moveTo === null) throw new Abort(`error: parse ${headerAt + 1}`);

  return (tree) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const parts = splitFile(needFile(tree, path));
    if (moveTo !== null && tree.read(moveTo) !== null) throw new EditError('exists', moveTo);
    // The chunks apply in order, with a cursor that starts at line 0 and moves to just after
    // the lines each chunk writes.
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(parts.lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new EditError('no-match', path);
        cursor = at + 1;
      }
      const oldSeg = chunk.body.filter((e) => e.kind !== 'new');
      const newSeg = chunk.body.filter((e) => e.kind !== 'old');
      if (oldSeg.length === 0) {
        const at = chunk.eof ? parts.lines.length : cursor;
        const adds = newSeg.map((e) => e.text);
        parts.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      const found = findLines(parts.lines, oldSeg.map((e) => e.text), strict, cursor, chunk.eof);
      if (found === null) throw new EditError('no-match', path);
      const at = found.spots[0]!;
      const seg = replacement(parts.lines, at, oldSeg, newSeg, found.tier);
      parts.lines.splice(at, oldSeg.length, ...seg);
      cursor = at + seg.length;
    }
    if (moveTo !== null) {
      tree.write(moveTo, joinFile(parts));
      tree.write(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.write(path, joinFile(parts));
    }
  };
}

// ---------------------------------------------------------------------------
// The command line, and order and atomicity (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(argv: string[]): { code: number; out: string[] } {
  // Options and PATCH may come in any order; -- ends the options. A usage error is an argument
  // that starts with - and is not - and not one of the options (before --), an option given
  // twice, a --format value other than the five names, or more than one positional argument.
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  let ended = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMAT_NAMES.includes(arg.slice('--format='.length))) {
        format = arg.slice('--format='.length);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  // PATCH is the patch file's path; when it is absent or -, the patch is read from standard
  // input. The errors are tried in order: usage, no-patch, format, parse.
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = readJsonEdits(text, lines);
    else if (kind === 'unified') edits = readUnified(lines, strict);
    else if (kind === 'search-replace') edits = readSearchReplace(lines, strict);
    else edits = readV4a(lines, strict);
    if (edits.length === 0) throw new Abort('error: parse 1');
  } catch (e) {
    if (e instanceof Abort) return { code: 2, out: [e.line] };
    throw e;
  }

  // Edits apply in the patch's order, each to the tree as the earlier edits left it. A failed
  // edit changes nothing and the edits after it still run, so every failure is reported; when
  // any edit failed, no file is written.
  const tree = new Tree();
  const failures: EditError[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves.length = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  // One line for each path whose state changed, in byte order of the paths (UTF-8). A move
  // that succeeded prints as one R line, sorted by the new path, replacing the pair's D and A.
  const renamed = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) {
      renamed.set(n, o);
    }
  }
  const movedAway = new Set(renamed.values());
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const [p, now] of tree.now) {
    if (tree.original(p) === now) continue;
    if (renamed.has(p)) rows.push({ key: p, line: `R ${renamed.get(p)} -> ${p}` });
    else if (movedAway.has(p)) continue;
    else rows.push({ key: p, line: `${tree.original(p) === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  // --check does everything but write: the same output and exit code, and no file is created,
  // changed or deleted.
  if (!checkOnly) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
