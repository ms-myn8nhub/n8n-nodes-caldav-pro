/**
 * Assert the published tarball contains what it should and nothing it should not.
 *
 * Both failure modes here have happened: a 64 kB incremental build cache shipped
 * with every release because package.json "files" takes precedence over
 * .npmignore, and the package declared MIT while shipping no licence text.
 * Neither breaks a test, so only a check like this catches them.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
	encoding: 'utf8',
	cwd: new URL('..', import.meta.url),
	shell: process.platform === 'win32',
});
const files = JSON.parse(raw)[0].files.map((f) => f.path.replace(/\\/g, '/'));

const problems = [];

// Everything the n8n manifest points at has to be in the tarball, or the node
// silently fails to register after install.
for (const declared of [...(pkg.n8n?.nodes ?? []), ...(pkg.n8n?.credentials ?? [])]) {
	if (!files.includes(declared)) problems.push(`n8n manifest points at a missing file: ${declared}`);
}

// A credential class that is written but never declared installs as a node with
// a credential type n8n has never heard of, which fails only in the editor.
for (const source of readdirSync(new URL('../credentials', import.meta.url))) {
	if (!source.endsWith('.credentials.ts')) continue;
	const declared = `dist/credentials/${source.replace(/\.ts$/, '.js')}`;
	if (!(pkg.n8n?.credentials ?? []).includes(declared)) {
		problems.push(`credential is not declared in the n8n manifest: ${declared}`);
	}
}

const required = ['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'dist/nodes/CalDav/CalDav.node.json'];
for (const name of required) {
	if (!files.includes(name)) problems.push(`missing from package: ${name}`);
}

const codex = JSON.parse(readFileSync(new URL('../nodes/CalDav/CalDav.node.json', import.meta.url), 'utf8'));
const expectedCodexNode = `${pkg.name}.calDav`;
if (codex.node !== expectedCodexNode) {
	problems.push(`CalDav.node.json node should be ${expectedCodexNode}, got ${codex.node}`);
}

if (pkg.main && !files.includes(pkg.main)) {
	problems.push(`package.json main points at a missing file: ${pkg.main}`);
}

// The node icon is loaded by filename at runtime, not imported, so nothing else
// would notice its absence.
if (!files.some((f) => /^dist\/nodes\/.+\.(svg|png)$/.test(f))) {
	problems.push('no node icon in dist/nodes');
}

const forbidden = [
	[/\.tsbuildinfo$/, 'incremental build cache'],
	[/^test\//, 'test sources'],
	[/^scripts\//, 'dev scripts'],
	[/^\.env/, 'environment file'],
	[/^(?!dist\/).*\.ts$/, 'TypeScript source outside dist'],
	[/smoke-test\.js$/, 'smoke test'],
];
for (const [pattern, label] of forbidden) {
	const hits = files.filter((f) => pattern.test(f));
	if (hits.length) problems.push(`${label} should not ship: ${hits.slice(0, 3).join(', ')}`);
}

console.log(`${files.length} files, ${pkg.name}@${pkg.version}`);
if (problems.length) {
	console.error('\npackage contents are wrong:');
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log('package contents look right.');
