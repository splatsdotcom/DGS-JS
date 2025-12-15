import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

//build workers:
//---------------
const workersDir = path.resolve('./src/workers');
const distWorkersDir = path.resolve('./dist/workers');

fs.mkdirSync(distWorkersDir, { recursive: true });
for(const file of fs.readdirSync(workersDir)) 
{
	if(!file.endsWith('.js')) 
		continue;

	build({
		entryPoints: [path.join(workersDir, file)],
		bundle: true,
		minify: true,
		format: 'esm',
		outfile: path.join(distWorkersDir, file),
	}).catch(() => process.exit(1));
}

//build main entry:
//---------------
build({
	entryPoints: ['src/index.js'],
	bundle: true,
	minify: true,
	format: 'esm',
	outfile: 'dist/index.js',
	loader: { '.wgsl': 'text' },
	external: ['gl-matrix'],
}).catch(() => process.exit(1));
