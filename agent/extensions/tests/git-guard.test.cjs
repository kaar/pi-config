const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// Load the extension with a mocked Pi API. Never execute the command strings.
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
  on: (name, fn) => {
    assert.equal(name, 'tool_call');
    handler = fn;
  },
});
const check = (command) => handler(
  { toolName: 'bash', input: { command } },
  { hasUI: false },
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
]) {
  test(`still blocks destructive commands: ${command}`, async () => {
    const result = await check(command);
    assert.equal(result?.block, true);
    assert.equal(result.reason, 'Blocked: destructive git command');
  });
}

test('still blocks interactive git commands', async () => {
  const result = await check('git merge feature');
  assert.equal(result?.block, true);
  assert.equal(result.reason, 'Blocked: interactive git command');
});

test('still requires commit approval', async () => {
  const result = await check('git commit -m "test"');
  assert.equal(result?.block, true);
  assert.equal(result.reason, 'Blocked bash: git commit requires approval');
});
