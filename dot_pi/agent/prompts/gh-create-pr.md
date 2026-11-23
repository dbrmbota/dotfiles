---
description: Create a GitHub pull request for the current branch with `gh pr create`
---

Create a pull request for the current branch. Inspect the branch with read-only
`git` and `gh` commands, then run `gh pr create`. The `gh` rules ask the user to
approve `gh pr create` before it runs, so the user reviews the PR payload first.

Return immediately (explain why, and create nothing) if:
- the current branch is `main` or `master`, or
- there is no base branch to compare against, or
- an open PR already exists for the current branch.

Steps:
1. Get the current branch: `git rev-parse --abbrev-ref HEAD`.
2. Determine the base branch (`main`, `master`, or the default branch of the
   upstream remote). If uncertain, pick the most likely one and say so.
3. Check for an existing PR: `gh pr list --head <branch> --state open --json url`.
   You can also use `gh pr view` for the current branch.
4. Inspect every change on the branch relative to the base, treating all commits on
   the branch as one net change. Useful commands:
   - `git log --oneline <base>..HEAD`
   - `git diff --stat <base>...HEAD`
   - `git diff <base>...HEAD`
   Do NOT list files or changes that were added and later removed on the branch —
   only the final net diff against the base matters.
5. Write a concise but exhaustive PR description: a one-line summary followed by a
   bulleted list of the net changes.
6. Run the command, with the body in a heredoc so it stays multiline:

```sh
gh pr create --base <base> --title "<title>" --body "$(cat <<'EOF'
<PR body>
EOF
)"
```

Rules:
- Quote the title safely and avoid unescaped double quotes inside it.
- Keep the `EOF` delimiter alone on its own line.
- Do not pipe or redirect stderr in the `gh pr create` command.
- If the user rejects the command, stop and report it. Do not retry.
- After creation, report the PR URL that `gh` prints.

If I provided additional instructions, honor them:
$ARGUMENTS
