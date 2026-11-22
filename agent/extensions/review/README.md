# Code review

This is an unmodified copy of [`extensions/review.ts` from mitsuhiko/agent-stuff at `0865c84`](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/review.ts), renamed to `index.ts` for Pi's extension discovery. See [LICENSE](LICENSE).

Run `/review` to choose a target, or use `/review uncommitted`, `/review branch main`, or `/review commit <sha>`. If offered a choice, select **Empty branch** to review without the current conversation. Use `/end-review` to return and choose whether to carry findings back. Loop fixing is off by default. PR review uses `gh` and checks out the PR in the current worktree.
