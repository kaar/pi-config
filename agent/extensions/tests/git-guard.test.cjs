const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// Load the extension with a mocked Pi API. Never execute the command strings.
// The exec mock runs Git discovery/tracking queries, never agent command strings.
const source = fs.readFileSync(path.join(__dirname, '../git-guard.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
function createHarness({ fileSystem = fs, home } = {}) {
  const extensionExports = {};
  vm.runInNewContext(outputText, {
    exports: extensionExports,
    require: (name) => {
      if (name === '@earendil-works/pi-coding-agent') {
        return { isToolCallEventType: (type, event) => event.toolName === type };
      }
      if (name === 'node:fs') return fileSystem;
      if (name === 'node:os' && home) return { ...require(name), homedir: () => home };
      return require(name);
    },
    process,
  });
  let handler;
  const execCalls = [];
  extensionExports.default({
    exec: async (cmd, args) => {
      assert.equal(cmd, 'git');
      assert.ok(args.includes('rev-parse') || args.includes('ls-files'));
      execCalls.push(args);
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    on: (name, fn) => {
      assert.equal(name, 'tool_call');
      handler = fn;
    },
  });
  return { handler, execCalls };
}
const { handler } = createHarness();
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

const checkFile = (f, toolName, filePath, ui, cwd = f.cwd) => f.handler(
  { toolName, input: { path: filePath } },
  { hasUI: Boolean(ui), cwd, ui },
);
const unexpectedUI = { select: () => assert.fail('unexpected approval dialog') };

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function fileFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(repoRoot, '.git-guard-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const [cwd, external, home, tmp, folders] = ['project', 'external', 'home', 'tmp', 'folders'].map((dir) => path.join(base, dir));
  for (const dir of [cwd, external, home, tmp, folders]) fs.mkdirSync(dir);
  for (const dir of [cwd, external]) assert.equal(spawnSync('git', ['-C', dir, 'init', '-q']).status, 0);
  for (const dir of [cwd, external, home, path.join(cwd, 'nested')]) {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'existing.md'), 'original');
  }
  fs.writeFileSync(path.join(cwd, 'untracked.md'), 'untracked');
  fs.writeFileSync(path.join(cwd, 'tracked.md'), 'tracked');
  assert.equal(spawnSync('git', ['-C', cwd, 'add', 'tracked.md']).status, 0);
  // Override only the roots, so negative fixtures work even in a temporary checkout.
  const roots = new Map([['/tmp', tmp], ['/var/folders', folders]]);
  const fileSystem = {
    ...fs,
    existsSync: (file) => roots.has(file) || fs.existsSync(file),
    lstatSync: (file, options) => fs.lstatSync(roots.get(file) ?? file, options),
    realpathSync: (file) => roots.get(file) ?? fs.realpathSync(file),
  };
  return { cwd, external, home, tmp, folders, fileSystem, ...createHarness({ fileSystem, home }) };
}

for (const tool of ['write', 'edit']) {
  test(tool + ': temporary roots bypass approval and Git discovery', async (t) => {
    const f = fileFixture(t);
    for (const root of [f.tmp, f.folders]) {
      fs.writeFileSync(path.join(root, 'existing.md'), 'temporary');
      for (const suffix of ['existing.md', 'missing/new.md']) {
        assert.equal(await checkFile(f, tool, path.join(root, suffix), unexpectedUI), undefined);
      }
    }
    assert.equal(f.execCalls.length, 0);
    const h = { ...createHarness({ fileSystem: {
      ...f.fileSystem,
      existsSync: (file) => file !== '/tmp' && file !== '/var/folders' && fs.existsSync(file),
    } }), cwd: f.cwd };
    assert.equal(await checkFile(h, tool, '.agents/existing.md', unexpectedUI), undefined);
  });

  test(tool + ': real temporary directories and canonical aliases', async (t) => {
    const allowed = ['/tmp', '/var/folders'].filter(fs.existsSync).map((root) => fs.realpathSync(root));
    const h = { ...createHarness(), cwd: repoRoot };
    for (const root of new Set(['/tmp', require('node:os').tmpdir()])) {
      if (!fs.existsSync(root) || !allowed.some((dir) => within(dir, fs.realpathSync(root)))) continue;
      const dir = fs.mkdtempSync(path.join(root, 'pi-git-guard-test-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      fs.writeFileSync(path.join(dir, 'existing.md'), 'temporary');
      for (const alias of new Set([dir, fs.realpathSync(dir)])) {
        for (const suffix of ['existing.md', 'missing/new.md']) {
          assert.equal(await checkFile(h, tool, path.join(alias, suffix), unexpectedUI), undefined);
        }
      }
    }
    assert.equal(h.execCalls.length, 0);
  });

  test(tool + ': project-local scope and ordinary approvals', async (t) => {
    const f = fileFixture(t);
    for (const suffix of ['existing.md', 'missing/new.md']) {
      assert.equal(await checkFile(f, tool, '../.agents/' + suffix, unexpectedUI, path.join(f.cwd, 'nested')), undefined);
    }
    fs.mkdirSync(path.join(f.cwd, '.agents-other'));
    fs.writeFileSync(path.join(f.cwd, '.agents-other', 'existing.md'), 'sibling');
    for (const target of [
      'untracked.md', 'nested/.agents/existing.md', '.agents-other/existing.md',
      path.join(f.home, '.agents/existing.md'), path.join(f.external, '.agents/existing.md'),
      '/tmp-other/new.md', '/private/tmp-other/new.md', '/var/folders-other/new.md', '/private/var/folders-other/new.md',
    ]) assert.equal((await checkFile(f, tool, target))?.block, true, target);
    for (const choice of ['No, block it', undefined, 'Yes, allow this once']) {
      let prompts = 0;
      const result = await checkFile(f, tool, 'untracked.md', { select: async () => { prompts++; return choice; } });
      assert.equal(prompts, 1);
      assert.equal(result?.block, choice === 'Yes, allow this once' ? undefined : true);
    }
    assert.equal(await checkFile(f, tool, 'untracked.md', unexpectedUI), undefined);
    for (const target of ['tracked.md', 'new.md']) assert.equal(await checkFile(f, tool, target), undefined);
    fs.rmSync(path.join(f.cwd, '.agents'), { recursive: true });
    assert.equal(await checkFile(f, tool, '.agents/missing/new.md', unexpectedUI), undefined);
    assert.equal((await checkFile(f, tool, 'nested/.agents/existing.md'))?.block, true);
    assert.equal(await checkFile(f, tool, path.join(f.home, 'new.md'), unexpectedUI, path.parse(f.cwd).root), undefined);
  });

  test(tool + ': root symlinks work but inner links cannot retain exemptions', async (t) => {
    const f = fileFixture(t);
    const local = path.join(f.cwd, '.agents');
    const trusted = path.join(f.external, '.agents');
    const outside = path.join(f.home, '.agents');
    fs.rmSync(local, { recursive: true });
    fs.symlinkSync(trusted, local, 'dir');
    for (const root of [local, trusted, f.tmp, f.folders]) {
      assert.equal(await checkFile(f, tool, path.join(root, 'missing/new.md'), unexpectedUI), undefined);
    }
    assert.equal(await checkFile(f, tool, path.join(trusted, 'existing.md'), unexpectedUI), undefined);
    for (const root of [local, f.tmp, f.folders]) {
      const link = path.join(root, 'link');
      fs.writeFileSync(path.join(root, 'existing.md'), 'trusted');
      fs.symlinkSync(root, link, 'dir');
      for (const suffix of ['existing.md', 'missing/new.md']) {
        assert.equal(await checkFile(f, tool, path.join(link, suffix), unexpectedUI), undefined);
      }
      // No file-tool success event is needed. Retarget the exact same paths.
      fs.unlinkSync(link);
      fs.symlinkSync(outside, link, 'dir');
      for (const suffix of ['existing.md', 'missing/new.md']) {
        assert.equal((await checkFile(f, tool, path.join(link, suffix)))?.block, true);
      }
    }
    const link = path.join(f.cwd, 'ordinary-link.md');
    fs.symlinkSync(path.join(outside, 'existing.md'), link);
    assert.equal(await checkFile(f, tool, link, { select: async () => 'Yes, allow this once' }), undefined);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(trusted, 'existing.md'), link);
    assert.equal(await checkFile(f, tool, link, unexpectedUI), undefined);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(outside, 'existing.md'), link);
    assert.equal((await checkFile(f, tool, link))?.block, true);
  });

  test(tool + ': dangling links and resolution failures do not get exemptions', async (t) => {
    const f = fileFixture(t);
    fs.symlinkSync(path.join(f.external, 'missing'), path.join(f.cwd, '.agents', 'dangling'), 'dir');
    for (const target of ['.agents/dangling', '.agents/dangling/new.md']) {
      assert.match((await checkFile(f, tool, target)).reason, /cannot resolve/);
    }
    const h = { ...createHarness({ fileSystem: { ...f.fileSystem, lstatSync: () => { throw new Error('permission denied'); } } }), cwd: f.cwd };
    assert.match((await checkFile(h, tool, '.agents/existing.md')).reason, /cannot resolve/);
    fs.rmSync(path.join(f.cwd, '.agents'), { recursive: true });
    fs.symlinkSync(path.join(f.external, 'missing'), path.join(f.cwd, '.agents'), 'dir');
    assert.equal((await checkFile(f, tool, '.agents/new.md'))?.block, true);
    assert.equal(await checkFile(f, tool, 'ordinary-new.md'), undefined);
  });
}
