import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice)(\.[a-z0-9]+)?$/i;

// esbuild reports inputs relative to absWorkingDir; the last node_modules segment names the installed copy.
function installedPackage(input) {
  const marker = 'node_modules/';
  const at = input.lastIndexOf(marker);
  if (at < 0) return null;
  const [first, second] = input.slice(at + marker.length).split('/');
  return input.slice(0, at + marker.length) + (first.startsWith('@') ? `${first}/${second}` : first);
}

const declaredLicense = pkg => typeof pkg.license === 'string'
  ? pkg.license
  : Array.isArray(pkg.licenses) ? pkg.licenses.map(entry => entry.type).join(' OR ') : 'UNKNOWN';
const repository = pkg => typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null;

async function noticesText({ inputs, root, bundle }) {
  const packages = new Map();
  for (const input of inputs) {
    const dir = installedPackage(input);
    if (!dir) continue; // project sources are not third-party packages
    const pkg = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8'));
    const name = pkg.name ?? basename(dir);
    const key = `${name}@${pkg.version}`;
    if (packages.has(key)) continue;
    const files = (await readdir(join(root, dir), { withFileTypes: true }))
      .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name)).map(entry => entry.name).sort();
    const texts = [];
    for (const file of files) texts.push((await readFile(join(root, dir, file), 'utf8')).trim());
    packages.set(key, { name, version: pkg.version ?? 'unknown', license: pkg.license, texts, repo: repository(pkg) });
  }
  const sections = [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(pkg => {
      // Never synthesise a license text: when the tarball ships none, state only what package.json declares.
      const body = pkg.texts.length ? pkg.texts.join('\n\n')
        : `The installed package ships no license text file. Declared license: ${declaredLicense(pkg)}.${pkg.repo ? ` Upstream: ${pkg.repo}` : ''}`;
      return `## package: ${pkg.name} ${pkg.version} — ${declaredLicense(pkg)}\n\n${body}`;
    });
  return `AnyWeb MCP third-party notices

Generated ${new Date().toISOString()} from the packages bundled into ${basename(bundle)}.
Each section reproduces the license text shipped by the installed package. This file is not a license for AnyWeb MCP itself.

${sections.join('\n\n')}
`;
}

export async function writeNotices({ file, inputs, root, bundle }) {
  const text = await noticesText({ inputs, root, bundle });
  await writeFile(file, text);
  return file;
}
