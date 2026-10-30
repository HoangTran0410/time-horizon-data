# time-horizon-data

All data of the Time Horizon project.

## Local Dev Server

To test external collections locally (without waiting for GitHub Pages to build):

```bash
node server.cjs           # port 5500 (default)
node server.cjs 8080      # custom port
```

Then update app's dev config (`src/hooks/useCatalogCollections.ts`) to `http://localhost:5500/data`


## Validating data

`scripts/validate.mjs` checks every collection under `collections/` plus
`collections-metadata.json` and `collection-groups.json`. It needs only Node 22
(no `npm install`) and runs in CI on every push and pull request
(`.github/workflows/validate.yml`).

```bash
node scripts/validate.mjs                  # full report
node scripts/validate.mjs histography      # only files whose path contains "histography"
node scripts/validate.mjs --quiet          # summary + errors only
node scripts/validate.mjs --json > r.json  # machine-readable (issues + yearMismatches list)
node scripts/validate.mjs --no-year-text   # skip the year-in-text heuristic
```

**Errors** (exit code 1) are things the app rejects or misrenders: invalid JSON or
a non-array file, missing/empty `title` or `emoji`, non-numeric `priority`, bad
`time`/`endTime` shape (1–6 integer parts, month 1–12, day valid for the month
incl. leap years, hour 0–23, minute/second 0–59, no day without month),
`endTime` before `time`, non-hex `color`, and catalog problems (duplicate ids,
a `dataUrl` that does not exist, a group category no collection uses).

**Warnings** (never fail the run) flag likely data-quality issues: year `0`
(there is no year 0; `-1` is 1 BC), `ongoing` together with `endTime`,
duplicate events (same title + time), localized `{vi, en}` objects missing a
language, a stored runtime `id`, collection files no `dataUrl` references, and
a heuristic that reports years written in the title, description or
Wikipedia link slug (`in 1896`, `năm 1896`, `500 BC`, `111 TCN`, `1960s`…)
that disagree with `time`/`endTime`. Each mismatch is tagged `likely-sign`,
`likely-digit` or `likely-transposed` when it looks like a typo of the stored
year.
