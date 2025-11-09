const { spawnSync } = require('child_process');

const packageFilePattern = new RegExp('^[A-Za-z0-9._/-]+$');
const envFilePattern = new RegExp('^\\.env(?:\\.|$)');
const sensitiveNamePattern = new RegExp('(?:token|secret|credential|credentials|passwd|password)', 'i');

const result = spawnSync('pnpm', ['exec', 'vsce', 'ls'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.status !== 0) {
  process.exit(result.status || 1);
}

const packageFiles = result.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => isPackageFileLine(line));

if (packageFiles.length === 0) {
  console.error('\nPackage boundary check failed. No package files were parsed from vsce ls output.');
  process.exit(1);
}

const deniedFiles = packageFiles.filter((file) => isDeniedPackageFile(file));

if (deniedFiles.length > 0) {
  console.error('\nPackage boundary check failed. Forbidden files would be published:');
  for (const file of deniedFiles) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(`\nPackage boundary check passed: ${packageFiles.length} files inspected.`);

function isPackageFileLine(line) {
  if (line.startsWith('(')) {
    return false;
  }

  if (
    line.startsWith('>') ||
    line.startsWith('[') ||
    line.startsWith('Executing ') ||
    line.startsWith('Use ') ||
    line.includes(' -> ')
  ) {
    return false;
  }

  if (line.includes(':')) {
    return false;
  }

  return packageFilePattern.test(line) && !line.startsWith('/') && !line.includes('..');
}

function isDeniedPackageFile(file) {
  const normalized = file.split('\\').join('/');
  const basename = normalized.split('/').pop() || normalized;

  if (
    startsWithAny(normalized, [
      '.github/',
      '.vscode/',
      'example/',
      'scripts/',
      'src/',
      'tests/',
    ])
  ) {
    return true;
  }

  if (
    [
      '.env',
      '.gitignore',
      '.vscodeignore',
      'AGENTS.md',
      'pnpm-lock.yaml',
      'requirements.md',
      'tsconfig.json',
    ].includes(normalized)
  ) {
    return true;
  }

  return (
    basename.endsWith('.vsix') ||
    basename.endsWith('.lock') ||
    basename === 'package-lock.json' ||
    basename === 'yarn.lock' ||
    basename === 'npm-shrinkwrap.json' ||
    envFilePattern.test(basename) ||
    sensitiveNamePattern.test(basename)
  );
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}
