import { $ } from 'bun';

const repoRoot = dirname(import.meta.dir);
const outputDir = resolvePath(repoRoot, Bun.env.NIGHTLY_OUT_DIR ?? 'nightly-dist');
const packageJsonPath = joinPath(repoRoot, 'package.json');
const packageJsonText = await Bun.file(packageJsonPath).text();
const packageJson = JSON.parse(packageJsonText);
const fullSha = await resolveGitSha();
const shortSha = fullSha.slice(0, 12);
const dateStamp = (Bun.env.NIGHTLY_DATE ?? new Date().toISOString().slice(0, 10)).replaceAll(
  '-',
  ''
);
const nightlyVersion = toNightlyVersion(packageJson.version, dateStamp, shortSha);

await assertFileExists(
  joinPath(repoRoot, 'dist', 'ghostty-web.js'),
  'Run `bun run build:lib` before packaging a nightly.'
);
await assertFileExists(
  joinPath(repoRoot, 'ghostty-vt.wasm'),
  'Run `./scripts/build-wasm.sh` before packaging a nightly.'
);
await ensureDirectory(outputDir);
await clearOutputDirectory(outputDir);

try {
  await Bun.write(
    packageJsonPath,
    `${JSON.stringify({ ...packageJson, version: nightlyVersion }, null, 2)}\n`
  );

  const packedTarballPath = (
    await $`bun pm pack --destination ${outputDir} --ignore-scripts --quiet`.cwd(repoRoot).text()
  ).trim();

  if (!packedTarballPath) {
    throw new Error('bun pm pack did not report an output tarball.');
  }

  const tarballPath = packedTarballPath.startsWith('/')
    ? packedTarballPath
    : joinPath(outputDir, packedTarballPath);
  const packedTarballName = basename(tarballPath);
  const tarballBuffer = await Bun.file(tarballPath).arrayBuffer();
  const sha256 = new Bun.CryptoHasher('sha256').update(tarballBuffer).digest('hex');
  const builtAt = new Date().toISOString();
  const metadata = {
    packageName: packageJson.name,
    version: nightlyVersion,
    commit: fullSha,
    builtAt,
    tarball: packedTarballName,
    sha256,
  };
  const repoUrl = normalizeRepositoryUrl(packageJson.repository?.url);
  const installUrl = repoUrl
    ? `${repoUrl}/releases/download/nightly/${packedTarballName}`
    : packedTarballName;

  await Bun.write(joinPath(outputDir, 'sha256.sum'), `${sha256}  ${packedTarballName}\n`);
  await Bun.write(joinPath(outputDir, 'nightly.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await Bun.write(
    joinPath(outputDir, 'NOTES.md'),
    [
      `Nightly build for \`${fullSha}\`.`,
      '',
      `Version: \`${nightlyVersion}\``,
      `Built at: \`${builtAt}\``,
      '',
      `Install with \`bun add ${installUrl}\`.`,
    ].join('\n')
  );

  console.log(`Created ${packedTarballName}`);
  console.log(`Nightly version: ${nightlyVersion}`);
  console.log(`Output directory: ${outputDir}`);
} finally {
  await Bun.write(packageJsonPath, packageJsonText);
}

async function resolveGitSha() {
  const envRef = Bun.env.NIGHTLY_REF?.trim();

  if (envRef) {
    return envRef;
  }

  return (await $`git rev-parse HEAD`.cwd(repoRoot).text()).trim();
}

function toNightlyVersion(version, dateStamp, shortSha) {
  const [baseVersion] = version.split('+');

  if (baseVersion.includes('-')) {
    return `${baseVersion}.nightly.${dateStamp}.sha${shortSha}`;
  }

  return `${baseVersion}-nightly.${dateStamp}.sha${shortSha}`;
}

function normalizeRepositoryUrl(repositoryUrl) {
  if (!repositoryUrl) {
    return null;
  }

  return repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '');
}

async function assertFileExists(targetPath, message) {
  if (await Bun.file(targetPath).exists()) {
    return;
  }

  throw new Error(message);
}

async function ensureDirectory(targetPath) {
  const keepFilePath = joinPath(targetPath, '.keep');

  await Bun.write(keepFilePath, '');
  await Bun.file(keepFilePath).delete();
}

async function clearOutputDirectory(targetPath) {
  for await (const relativePath of new Bun.Glob('**/*').scan({
    cwd: targetPath,
  })) {
    await Bun.file(joinPath(targetPath, relativePath)).delete();
  }
}

function resolvePath(basePath, targetPath) {
  if (targetPath.startsWith('/')) {
    return targetPath;
  }

  return joinPath(basePath, targetPath);
}

function joinPath(...parts) {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

function dirname(path) {
  const normalizedPath = path.replace(/\/+$/, '');
  const lastSlashIndex = normalizedPath.lastIndexOf('/');

  if (lastSlashIndex <= 0) {
    return '/';
  }

  return normalizedPath.slice(0, lastSlashIndex);
}

function basename(path) {
  const normalizedPath = path.replace(/\/+$/, '');
  const lastSlashIndex = normalizedPath.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return normalizedPath;
  }

  return normalizedPath.slice(lastSlashIndex + 1);
}
