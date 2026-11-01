# turn-review

`/review` opens the file changes from your last agent turn in tuicr so you can leave review comments. When you export them, the text goes into the pi editor.

## Requirements

- `tuicr` on your `PATH` (≥ 0.28 to close rounds without comments).
- omp-undo-redo installed and recording snapshots for pi sessions.
- The current directory is inside a git repository.
- pi runs in the interactive TUI. `/review` does not work in print or RPC mode.

`/review` takes no arguments.

## How a review round works

- **First round in a session:** the review covers the whole session. It starts at the earliest surviving "before" snapshot and ends at the latest "after" snapshot.
- **Later rounds:** the review starts at the commit of the last reviewed round. It shows only the new changes.
- **`/undo`:** the end of the review follows the current snapshot, so undone turns are left out.
- **Only an export or a clean close counts.** Press `y` in tuicr to export. The round is then marked as reviewed. Quitting with `:q` (bare `q` no longer quits in tuicr 0.28) exports nothing, so the round is not marked. Running `/review` again reopens the same changes, with your comments still there. The one exception is the next bullet.
- **Approve without comments:** mark every file reviewed with `r`, add no comments, and quit with `:q`. The round is marked reviewed and nothing is pasted. This needs tuicr ≥ 0.28, which prints the exit summary. Older versions keep the old behavior (no marker).
- **Nothing new:** if the snapshots are identical, `/review` says "nothing to review since …" and stops.

After an export, the text is pasted into the editor. Press Enter to send it to the agent.

## Waiting for omp-undo-redo

omp-undo-redo writes its history after each turn. If `/review` runs before it has recorded the last turn, a loader appears. It ends as soon as the history is updated.

Press Esc to stop waiting. You then get two choices:

- **Review up to the previous snapshot:** reviews only the turns that are already recorded.
- **Cancel:** does nothing.

There is no time limit on the wait.

## Warnings

- **Last turn has no file snapshot:** the turn's changes show up in the next round.
- **Previous review commit is gone:** git removed it, for example with `git gc`. `/review` then reviews the whole session again.

## What it leaves behind

- **Pack files and dangling commits:** each round adds a pack and a review commit to the repository's object database. No branch or tag points to them. `git gc` removes them after `gc.pruneExpire`.
- **Session entries:** each reviewed round adds a `turn-review` entry to the pi session. These entries belong to the current branch, so `/tree` and forks behave as expected.
- **tuicr sessions:** tuicr keeps its own session data. You can resume a round from tuicr's Sessions tab.

## What it does not change

`/review` does not touch your index, working tree, `HEAD`, branches, or refs.

## Limits

- It compares snapshots only. Edits made after the last snapshot are not shown.
- omp-undo-redo keeps history for a limited time, so very old turns may be gone.
- It works only inside git repositories. Other workspaces are not supported.
- The `-w` (workspace) option of tuicr is not used.
- The readiness check assumes no other extension adds session entries inside `before_agent_start`. If that happens, you may see a wait that Esc ends. It never shows a wrong diff.

## Settings

- `OMP_UNDO_REDO_STORE_DIR`: where omp-undo-redo keeps its store. The default is `~/.omp/omp-undo-redo`.

## Tests

From the extension directory in the chezmoi source (`dot_pi/agent/extensions/turn-review`):

```sh
node --test
```
