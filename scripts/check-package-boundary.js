const { spawnSync } = require('child_process');

const packageFilePattern = new RegExp('^[A-Za-z0-9._/-]+$');
const envFilePattern = new RegExp('^\\.env(?:\\.|$)');
const sensitiveNamePattern = new RegExp('(?:token|secret|credential|credentials|passwd|password)', 'i');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const requiredRuntimeAssets = [
  'dist/extension.js',
  'media/main.js',
  'media/vendor/ag-grid-community.min.js',
  'media/vendor/papaparse.min.js',
];

const result = spawnSync(pnpmCommand, ['exec', 'vsce', 'ls'], {
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

if (result.error) {
  console.error(`\nFailed to run ${pnpmCommand}: ${result.error.message}`);
  console.error(result.error);
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

const packageFileSet = new Set(packageFiles.map((file) => file.split('\\').join('/')));
const missingRequiredRuntimeAssets = requiredRuntimeAssets.filter((file) => !packageFileSet.has(file));

if (missingRequiredRuntimeAssets.length > 0) {
  console.error('\nPackage boundary check failed. Required runtime assets are missing:');
  for (const file of missingRequiredRuntimeAssets) {
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
      '.netrc',
      '.npmrc',
      '.pypirc',
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
    basename.endsWith('.pem') ||
    basename.endsWith('.key') ||
    basename.endsWith('.lock') ||
    basename === '.netrc' ||
    basename === '.npmrc' ||
    basename === '.pypirc' ||
    basename === 'id_dsa' ||
    basename === 'id_ecdsa' ||
    basename === 'id_ed25519' ||
    basename === 'id_rsa' ||
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
