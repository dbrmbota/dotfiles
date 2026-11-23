# Bash

- Never combine a heredoc (`<<`), stderr redirect (`2>&1` or `2>file`), and pipe (`|`) in one command. Use `|&`, group the command (`{ cmd <<'EOF' ...; } 2>&1 | ...`), or write to a temp file and redirect (`< file`).
- Avoid `bash -c`, `sh -c`, `sudo`, `xargs`, and `find -exec`. Run commands directly or chain with `&&` or `;`.
