import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const [assetsArg, metadataArg, outArg = 'artifacts/site'] = process.argv.slice(2);
if (!assetsArg || !metadataArg)
  throw Error('Usage: node scripts/build-website.mjs ASSETS RELEASE_JSON [OUTPUT]');
const assetsDir = resolve(assetsArg),
  out = resolve(outArg);
const release = JSON.parse(await readFile(metadataArg, 'utf8'));
const version = release.tagName;
if (!/^v\d+\.\d+\.\d+$/.test(version) || release.isDraft || release.isPrerelease)
  throw Error('A stable published release is required');
const names = {
  installer: `Inkdown_${version.slice(1)}_x64-setup.exe`,
  portable: `Inkdown_${version.slice(1)}_x64-standalone.zip`,
  binary: 'Inkdown.exe',
  license: 'LICENSE',
  notices: 'THIRD_PARTY_NOTICES.txt',
  checksums: 'SHA256SUMS.txt',
};
const sums = new Map();
for (const line of (await readFile(join(assetsDir, names.checksums), 'utf8'))
  .replace(/^\uFEFF/, '')
  .trim()
  .split(/\r?\n/)) {
  const match = /^([a-fA-F0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
  if (!match || sums.has(match[2])) throw Error('Invalid or duplicate checksum entry');
  sums.set(match[2], match[1].toLowerCase());
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const data = {
  version,
  date: new Date(release.publishedAt).toISOString().slice(0, 10),
  assets: {},
};
// Validate everything before writing an output directory.
for (const [key, name] of Object.entries(names)) {
  const bytes = await readFile(join(assetsDir, name));
  if (key !== 'checksums' && sums.get(name) !== hash(bytes))
    throw Error(`Checksum mismatch: ${name}`);
  data.assets[key] = { name, size: bytes.length, sha256: hash(bytes) };
}
try {
  await stat(out);
  throw Error('Output already exists; choose a fresh directory');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await mkdir(out, { recursive: true });
await cp('website', out, { recursive: true });
const downloads = join(out, 'downloads', version);
await mkdir(downloads, { recursive: true });
for (const name of Object.values(names)) await cp(join(assetsDir, name), join(downloads, name));
await writeFile(join(out, 'release.json'), JSON.stringify(data, null, 2) + '\n');
const manifest = {};
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(dir, entry.name), relative + '/');
    else if (entry.isFile()) manifest[relative] = hash(await readFile(join(dir, entry.name)));
    else throw Error('Unexpected non-file');
  }
}
await walk(out);
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${version}: ${Object.keys(manifest).length} verified files in ${out}`);
