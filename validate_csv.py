"""
Sanity-checks account CSVs before publish.sh commits/publishes anything.
Catches the failure mode from 2026-07-03: a dedup script crashed mid-write
and truncated TrendForce.csv from ~570 rows to 12, which then got committed
and published silently because nothing checked row counts or file shape.

Exit code 0 = all clear. Exit code 1 = one or more accounts failed a check;
publish.sh aborts before touching git so a corrupt scrape never goes live.
"""
import csv
import os
import subprocess
import sys

BASE = os.path.dirname(__file__)
CSV_DIR = os.path.join(BASE, 'csv')
ACCOUNTS = ['TrendForce', 'technews_tw', 'dylan522p', 'jukan05', 'QQ_Timmy', 'SemiAnalysis_']
# hasVideo was added 2026-07-22 as a new trailing column - rows scraped
# before that change are exactly one field short until their next refresh
# (scrape_accounts.js backfills it in place within each row's 7-day
# refresh window), so being short by exactly 1 is expected, not corrupt.
EXPECTED_COLUMNS = 11
# Row count is allowed to shrink a little (in-place stat refreshes don't
# change count, but the self-healing dedup can legitimately drop a few
# duplicate rows). A bigger drop than this means something is actually broken.
MAX_ALLOWED_DROP_PCT = 15


def git_committed_row_count(relpath):
    """Row count of this file as of the last commit, or None if untracked/unavailable."""
    try:
        out = subprocess.run(
            ['git', 'show', f'HEAD:{relpath}'],
            cwd=BASE, capture_output=True, text=True, check=True,
        ).stdout
        return max(0, len(out.splitlines()) - 1)  # minus header
    except subprocess.CalledProcessError:
        return None


def check_csv(handle):
    """Returns a list of problem strings for this account; empty list = OK."""
    problems = []
    path = os.path.join(CSV_DIR, f'{handle}.csv')
    relpath = os.path.relpath(path, BASE)

    if not os.path.exists(path):
        problems.append(f'{handle}.csv does not exist')
        return problems

    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            problems.append(f'{handle}.csv is empty (no header)')
            return problems

        # Same tolerance as the row check below: hasVideo was added as a new
        # trailing column, and scrape_accounts.js only rewrites a file's
        # header when it actually has something to write for that account —
        # one short by exactly 1 just means it hasn't been touched since.
        if len(header) != EXPECTED_COLUMNS and len(header) != EXPECTED_COLUMNS - 1:
            problems.append(
                f'{handle}.csv header has {len(header)} columns, expected {EXPECTED_COLUMNS} '
                f'(or {EXPECTED_COLUMNS - 1} pre-hasVideo)'
            )

        malformed_lines = []
        row_count = 0
        for i, row in enumerate(reader, start=2):
            row_count += 1
            if len(row) < len(header) - 1:
                malformed_lines.append(i)
            elif len(row) > len(header) and any(f.strip() for f in row[len(header):]):
                # Extra columns only count as malformed if they hold real
                # content — a harmless trailing empty field (long-standing,
                # pre-existing in these CSVs) is not a corruption signal.
                malformed_lines.append(i)

        if malformed_lines:
            shown = malformed_lines[:5]
            more = f' (+{len(malformed_lines) - 5} more)' if len(malformed_lines) > 5 else ''
            problems.append(
                f'{handle}.csv has {len(malformed_lines)} malformed row(s) at line(s) {shown}{more}'
            )

    if row_count == 0:
        problems.append(f'{handle}.csv has a header but zero data rows')
        return problems

    prev_count = git_committed_row_count(relpath)
    if prev_count and prev_count > 0:
        drop_pct = (prev_count - row_count) / prev_count * 100
        if drop_pct > MAX_ALLOWED_DROP_PCT:
            problems.append(
                f'{handle}.csv row count dropped {drop_pct:.0f}% '
                f'({prev_count} -> {row_count}), exceeds {MAX_ALLOWED_DROP_PCT}% threshold'
            )

    return problems


def main():
    all_problems = {}
    for handle in ACCOUNTS:
        problems = check_csv(handle)
        if problems:
            all_problems[handle] = problems

    if not all_problems:
        print('validate_csv: all account CSVs look healthy.')
        return 0

    print('validate_csv: FAILED — one or more account CSVs look corrupt:\n', file=sys.stderr)
    for handle, problems in all_problems.items():
        for p in problems:
            print(f'  [{handle}] {p}', file=sys.stderr)
    print('\nAborting before commit/publish. Fix the underlying CSV(s) and re-run.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
