# TODO

## Change Structure
Change the structure of the project and move everything out of agents into root

Before:
```sh
.
├── agent
│   ├── auth.json
│   ├── bin
│   ├── extensions
│   ├── prompts
│   ├── sessions
│   ├── settings.json
│   └── skills
├── docs
│   ├── extensions.md
│   ├── git-guard-review.md
│   └── git-guard-summary.md
├── git-guard.ts
├── install.sh
└── README.md
```

After:
```sh
.
├── auth.json
├── bin
├── extensions
├── prompts
├── sessions
├── settings.json
├── skills
├── docs
│   ├── extensions.md
│   ├── git-guard-review.md
│   └── git-guard-summary.md
├── git-guard.ts
├── install.sh
└── README.md
```

And then install it like:

```sh
git clone https://github.com/kaar/pi-config ~/.pi/agent
# Or
ln -S $PWD ~/.pi/agent
```

The install script can be either updated or removed.

## Sharing Skills

I currently have duplicated skills both in Claude & PI.

Here I have skills under `~/.pi/agent/skills` and for Claude under `~/.claude/skills`

It would be possible to also store all the skills under `~/.agents/skills/` so that Claude and PI can share them.
