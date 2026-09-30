const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// Load the extension with a mocked Pi API. Never execute the command strings.
// The exec mock only executes git ls-files to check tracked targets.
const source = fs.readFileSync(path.join(__dirname, '../git-guard.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const extensionExports = {};
vm.runInNewContext(outputText, {
  exports: extensionExports,
  require: (name) => name === '@earendil-works/pi-coding-agent'
    ? { isToolCallEventType: (type, event) => event.toolName === type }
    : require(name),
  process,
});
let handler;
extensionExports.default({
  exec: async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
  on: (name, fn) => {
    assert.equal(name, 'tool_call');
    handler = fn;
  },
});
const repoRoot = path.join(__dirname, '../../..');
const check = (command) => handler(
  { toolName: 'bash', input: { command } },
  { hasUI: false, cwd: repoRoot },
);

for (const command of [
  'git add .pi/skills/valheim-update/SKILL.md README.md docs/progress.md docs/verification/2026-09-22-update-skill.md',
  'git add ./README.md',
  'git add README.md',
  'git add .',
  'git add -A',
  'git add --all',
]) {
  test(`allows staging: ${command}`, async () => {
    assert.equal(await check(command), undefined);
  });
}

for (const command of [
  'git reset --hard',
  'git clean -fd',
  'git checkout .',
  'git stash',
  'git rm -f README.md',
  'git rm --force README.md',
  'git add README.md && git reset --hard',
  'git branch -f master HEAD && git switch master',
  'git branch --force main origin/main',
  'git branch topic -f HEAD~1',
]) {
  test(`still blocks destructive commands: ${command}`, async () => {
    const result = await check(command);
    assert.equal(result?.block, true);
    assert.equal(result.reason, 'Blocked: destructive git command');
  });
}

for (const command of [
  'git branch',
  'git branch -a',
  "git branch --format='%(refname)'",
  'git branch feature && rm -f tmp.txt',
]) {
  test(`allows non-destructive branch commands: ${command}`, async () => {
    assert.equal(await check(command), undefined);
  });
}

for (const command of [
  'git show :2:README.md > /tmp/ours.md',
  'git show HEAD:README.md >> README.md',
  'git show HEAD:README.md 2>/dev/null',
  'cp README.md /tmp/readme.bak',
  'cp "$source" "$target_dir/"',
  'cp README.md does-not-exist.md',
]) {
  test(`allows non-overwriting file commands: ${command}`, async () => {
    assert.equal(await check(command), undefined);
  });
}

for (const command of [
  'GIT_EDITOR=true git rebase --continue && git status --short && git log -1 --oneline',
  'GIT_EDITOR=true git rebase --continue && git status --short --branch && git log --oneline -3',
  'GIT_EDITOR=true git rebase --continue && git status --short --branch && git diff --check && bash scripts/check-docs.sh && git log --oneline --decorate -4',
  'cd /Users/casparnettelbladt/Dev/valheim && git add docs/progress.md && GIT_EDITOR=true git rebase --continue',
  'git add docs/progress.md && GIT_EDITOR=true git rebase --continue && git status --short --branch && git log --oneline --decorate -3 && git diff --check origin/master...HEAD',
  'env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase --continue',
  'export GIT_EDITOR=true; git rebase --continue',
  'GIT_EDITOR=true\ngit rebase --continue',
]) {
  test(`allows rebase continuation with editor configured: ${command}`, async () => {
    assert.equal(await check(command), undefined);
  });
}

for (const command of [
  'git show :3:README.md > README.md && git add README.md',
  'cp /tmp/x.md README.md',
  'cp -p "/tmp/x.md" "README.md"',
]) {
  test(`blocks overwriting tracked files: ${command}`, async () => {
    const result = await check(command);
    assert.equal(result?.block, true);
    assert.ok(result.reason.startsWith('Blocked bash: command overwrites tracked file'));
  });
}

for (const command of [
  'git merge feature',
  'git rebase --continue',
  'git add x && git rebase --continue',
]) {
  test(`still blocks interactive git commands: ${command}`, async () => {
    const result = await check(command);
    assert.equal(result?.block, true);
    assert.equal(result.reason, 'Blocked: interactive git command');
  });
}

test('still requires commit approval', async () => {
  const result = await check('git commit -m "test"');
  assert.equal(result?.block, true);
  assert.equal(result.reason, 'Blocked bash: git commit requires approval');
});
