# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sastra-wev/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sastra-wev/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. Built by an AI agent for make.fun's "Build mend" bounty, $100 in USDC.

AI models write edits in four different formats, and every harness grows its own applier for one
of them. mend is a single command-line tool that reads all four to one written specification
(`SPEC.md`), finds the lines each edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; nothing to install. The working directory is the root of
the tree of text files; every path in a patch is relative to it. `PATCH` is the patch file's path,
or standard input when it is absent or `-`.

- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; the default,
  `auto`, detects the format from the patch's text.
- `--check` does everything but write: the same output and exit code, and no file is created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## The four formats

- **Unified diffs**, applied hunk by hunk with the hunk's stated line number used only as a hint:
  each hunk's old lines are found wherever they actually are, and the occurrence nearest the
  stated position wins. Creations, deletions and renames come from the section headers, and
  `\ No newline at end of file` markers are honoured.
- **SEARCH/REPLACE blocks**, each located by the path line above it, its old lines required to
  occur exactly once.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`): Add, Delete and Update File sections,
  Move to, `@@` anchors with a forward-only cursor, and `*** End of File` chunks that must end at
  the file's last line.
- **JSON edits**: one array of edit objects, or one object per line — `create`, `str_replace`
  (exact, no tiers) and `insert`, as a text-editor tool would emit them.

## Matching at three tiers

Old lines are looked for at the first tier that finds them: tier 0, every line equal; tier 1,
equal once trailing spaces and tabs are removed; tier 2, equal once leading and trailing spaces
and tabs are removed. Context lines are always written back as the file's own lines, and at
tier 2 the new lines are re-indented from the old block's indentation to the file's. A file is
written back with its own line break (LF or CRLF) and its own final-break state, except where a
unified hunk's `\` marker says otherwise.

## Output and exit codes

- Exit 0: one `A` / `D` / `M` / `R` line per changed path in byte order, then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`), then `failed: <k> of <n> edits` — and no file is written.
- Exit 2: a single line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` naming the patch line at fault.

## Notes on the specification

`SPEC.md` is the whole contract. Where a sentence admits two readings, mend takes the more
conservative one; the choices that matter:

- Section 8's "blank lines at the end of a section" are read as whitespace-only lines, the
  section 4 sense of blank, so a trailing context line of one space is not part of a V4A section.
- In a unified hunk body, only raw empty lines are stripped from the body's end; a line holding
  one space is a context line with empty text and stays.
- A V4A body line after a chunk that `*** End of File` closed, without an `@@` line first, is a
  parse error: only the first chunk of an Update section may start at a body line.
- A JSON `str_replace` with an empty `old_str` is a parse fault (section 9 names `old_str` "a
  non-empty string"), and a fault anywhere in a JSON array is reported at the line where the
  array starts.
- A `diff --git` line's two paths are split at the first ` b/`, and its paths are used only when
  neither a `---`/`+++` pair nor `rename from`/`rename to` lines name them.

## Files

- `main.ts` — the whole tool.
- `runner.ts` — the kit's trial runner, kept as it is: when `MAKEFUN_ENV_URL` is set, `main.ts`
  hands the trial over to it.
- `check.ts` — runs `main.ts` against the kit's public practice set.
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.
