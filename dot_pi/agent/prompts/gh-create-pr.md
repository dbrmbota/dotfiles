---
description: Inspect all changes on the branch and print a ready-to-run `gh pr create` command
---

You do NOT have access to `~/.ssh`, so `gh` cannot authenticate/talk to GitHub
from your sandbox — any attempt to run `gh` will fail. Never attempt to run `gh`
(or otherwise reach GitHub). Your job is to inspect the branch locally using
read-only `git` commands, then print a single ready-to-copy-paste `gh pr create`
command in a fenced code block so I can run it manually.

Return immediately (explain why, print no command) if:
- the current branch is `main` or `master`, or
- there is no base branch to compare against, or
- a PR already exists for the current branch — you cannot check this offline, so
  infer what you can from local state and state your assumption.

Steps:
1. Get the current branch: `git rev-parse --abbrev-ref HEAD`.
2. Determine the base branch (`main`, `master`, or the default branch of the
   upstream remote). If uncertain, pick the most likely one and say so.
3. Inspect every change on the branch relative to the base, treating all commits on
   the branch as one net change. Useful commands:
   - `git log --oneline <base>..HEAD`
   - `git diff --stat <base>...HEAD`
   - `git diff <base>...HEAD`
   Do NOT list files or changes that were added and later removed on the branch —
   only the final net diff against the base matters.
4. Craft a concise but exhaustive PR description: a one-line summary followed by a
   bulleted list of the net changes.
5. Print exactly one command, using a heredoc for the body so it stays multiline:

```sh
gh pr create --base <base> --title "<title>" --body "$(cat <<'EOF'
<PR body>
EOF
)"
```

Rules for the output:
- Emit the command in a single fenced code block. Put at most one short sentence
  outside it (e.g. the assumed base branch); no other prose.
- Quote the title safely and avoid unescaped double quotes inside it.
- Keep the `EOF` delimiter alone on its own line.
- Do not attempt to execute the command.

If I provided additional instructions, honor them:
$ARGUMENTS
