#!/usr/bin/env python3
"""Claude Code PreToolUse hook (Bash) — BL-014 Phase 3.

Refuses, before they run:
  - `gh pr merge` while any of the PR's checks is failing, pending or cancelled,
    or when the PR reports no checks at all;
  - `gh pr merge --admin` (it bypasses branch protection);
  - `gh pr merge` on a PR over REVIEW_THRESHOLD changed lines (data, fixtures and
    lockfiles excluded) that has no `reviewed` label;
  - `git push` to main of anything but docs-only commits (`*.md` outside
    `packages/*/src/`), and any force push to main.

The command is tokenised with shlex, so `gh pr merge` quoted inside a commit message
or a heredoc is text, not a merge. Exit 2 blocks the tool call; stderr is shown to
Claude as the reason. Fails closed: a merge or push to main that cannot be checked
is refused.
"""

import json
import os
import re
import shlex
import subprocess
import sys

REVIEW_THRESHOLD = 500
REVIEW_LABEL = "reviewed"
# Paths that do not count towards the review threshold.
EXCLUDE_RE = re.compile(
    r"(^|/)(data|fixtures|__fixtures__|golden|goldens|__snapshots__)/"
    r"|(^|/)(bun\.lock|uv\.lock|package-lock\.json)$"
    r"|\.(csv|parquet|jsonl)$"
)
SHELLS = {"bash", "sh", "zsh"}
WRAPPERS = {"command", "env", "exec", "nohup", "time", "sudo"}
MERGE_VALUE_OPTS = {"-t", "--subject", "-b", "--body", "-F", "--body-file",
                    "--match-head-commit", "-A", "--author-email", "-R", "--repo"}
PUSH_VALUE_OPTS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
FORCE_OPTS = {"-f", "--force", "--force-with-lease", "--force-if-includes"}
MAIN_REFS = {"main", "refs/heads/main"}


class Blocked(Exception):
    pass


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=45)


def simple_commands(cmd):
    """Split a shell command line into argv lists at ; & | && || ( ) and redirections."""
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError:  # unbalanced quotes — the shell would reject it too
        tokens = cmd.split()
    argv = []
    for tok in tokens:
        if tok and set(tok) <= set(";&|()<>"):
            if argv:
                yield argv
            argv = []
        else:
            argv.append(tok)
    if argv:
        yield argv


def strip_prefix(argv):
    """Drop `FOO=bar` assignments and wrappers such as `env` or `command`."""
    while argv and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]) or argv[0] in WRAPPERS):
        argv = argv[1:]
    return argv


def split_opts(args, value_opts):
    """Return (flags, values, positionals); a value-taking option swallows its value."""
    flags, values, positional, i = set(), {}, [], 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and arg != "-":
            name, eq, value = arg.partition("=")
            flags.add(name)
            if eq:
                values[name] = value
            elif name in value_opts and i + 1 < len(args):
                values[name] = args[i + 1]
                i += 1
        else:
            positional.append(arg)
        i += 1
    return flags, values, positional


def check_merge(args, cwd):
    flags, values, positional = split_opts(args, MERGE_VALUE_OPTS)
    if "--admin" in flags:
        raise Blocked("`gh pr merge --admin` bypasses branch protection. Merge without it once checks are green.")
    selector = positional[:1]
    repo_name = values.get("--repo") or values.get("-R")
    repo = ["--repo", repo_name] if repo_name else []
    label = f"PR {selector[0]}" if selector else "the PR of this branch"

    # gh exits non-zero when checks fail or are pending; the JSON is still printed.
    out = run(["gh", "pr", "checks", *selector, *repo, "--json", "name,bucket"], cwd).stdout
    try:
        checks = json.loads(out)
    except json.JSONDecodeError:
        raise Blocked(f"could not read the checks for {label}. Run `gh pr checks` and merge only when every check passes.")
    if not checks:
        raise Blocked(f"{label} reports no checks yet. Wait for CI to start and pass.")
    bad = sorted({f"{c['name']} ({c['bucket']})" for c in checks if c["bucket"] in ("fail", "pending", "cancel")})
    if bad:
        raise Blocked(f"{label} is not green: {', '.join(bad)}. Wait for, or fix, these checks before merging.")

    view = run(["gh", "pr", "view", *selector, *repo, "--json", "number,url,labels"], cwd)
    if view.returncode:
        raise Blocked(f"could not read {label} to measure its size.")
    pr = json.loads(view.stdout)
    nwo = re.search(r"github\.com/([^/]+/[^/]+)/pull", pr["url"]).group(1)
    # The REST files endpoint paginates; `gh pr view --json files` stops at 100.
    files = run(["gh", "api", "--paginate", f"repos/{nwo}/pulls/{pr['number']}/files?per_page=100",
                 "--jq", '.[] | "\\(.additions + .deletions)\\t\\(.filename)"'], cwd)
    if files.returncode:
        raise Blocked(f"could not list the files of PR {pr['number']}.")
    size = sum(int(n) for n, path in (line.split("\t", 1) for line in files.stdout.splitlines())
               if not EXCLUDE_RE.search(path))
    if size > REVIEW_THRESHOLD and REVIEW_LABEL not in {lb["name"] for lb in pr["labels"]}:
        raise Blocked(f"PR {pr['number']} changes {size} lines (excluding data, fixtures and lockfiles), over the "
                      f"{REVIEW_THRESHOLD}-line review threshold. Run /code-review, post its result on the PR, "
                      f"then add the `{REVIEW_LABEL}` label.")


def check_push(args, cwd):
    flags, _, positional = split_opts(args, PUSH_VALUE_OPTS)
    force = any(f in FORCE_OPTS for f in flags)
    current = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.strip()

    def resolve(ref):
        return current if ref in ("HEAD", "@") else ref

    src = None
    refspecs = positional[1:]
    if "--all" in flags or "--mirror" in flags:
        src = "main"
    elif not refspecs:
        if current == "main":
            src = "HEAD"
    for ref in refspecs:
        if ref.startswith("+"):
            force, ref = True, ref[1:]
        local, _, remote = ref.partition(":")
        if resolve(remote or local) in MAIN_REFS:
            src = local or "main"
    if src is None:
        return
    if force:
        raise Blocked("force push to main is not allowed.")

    run(["git", "fetch", "-q", "origin", "main"], cwd)
    diff = run(["git", "diff", "--name-only", f"origin/main...{src}"], cwd)
    if diff.returncode:
        raise Blocked("could not tell what this push to main contains. Push a branch and open a PR.")
    offending = [f for f in diff.stdout.splitlines()
                 if not f.endswith(".md") or re.match(r"^packages/[^/]+/src/", f)]
    if offending:
        raise Blocked("only docs-only commits (*.md outside packages/*/src) may go straight to main. "
                      f"This push also changes: {' '.join(offending[:5])}. Push a branch and open a PR.")


def check(cmd, cwd):
    for argv in simple_commands(cmd):
        argv = strip_prefix(argv)
        if not argv:
            continue
        name = os.path.basename(argv[0])
        if name == "cd" and len(argv) > 1:
            cwd = os.path.join(cwd, os.path.expanduser(argv[1]))
        elif name in SHELLS and "-c" in argv[:-1]:
            check(argv[argv.index("-c") + 1], cwd)
        elif name == "gh" and argv[1:3] == ["pr", "merge"]:
            check_merge(argv[3:], cwd)
        elif name == "git":
            rest = argv[1:]
            while rest and rest[0].startswith("-"):  # git -C dir / -c k=v before the subcommand
                if rest[0] == "-C" and len(rest) > 1:
                    cwd = os.path.join(cwd, rest[1])
                rest = rest[2:] if rest[0] in ("-C", "-c") else rest[1:]
            if rest[:1] == ["push"]:
                check_push(rest[1:], cwd)


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    if not re.search(r"\bgh\b.*\bpr\b.*\bmerge\b|\bgit\b.*\bpush\b", cmd, re.S):
        return 0  # fast path for every other command
    try:
        check(cmd, cwd)
    except Blocked as e:
        print(f"merge-guard (BL-014): {e}", file=sys.stderr)
        return 2
    except Exception as e:  # fail closed on anything unexpected
        print(f"merge-guard (BL-014): could not check this command ({e!r}); refusing it.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
