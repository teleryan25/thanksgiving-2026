import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Generates dist/sw.js after the build with a precache list of EVERY emitted asset and a
 * content-hash cache name, plus dist/asset-manifest.json the app uses to verify the cache.
 */
export function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'tcc-service-worker',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    closeBundle() {
      const outDir = config.build.outDir;
      const base = config.base;
      const files = walk(outDir)
        .map((p) => relative(outDir, p).split('\\').join('/'))
        .filter((f) => f !== 'sw.js' && f !== 'asset-manifest.json' && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const urls = ['', ...files].map((f) => base + f);
      writeFileSync(join(outDir, 'asset-manifest.json'), JSON.stringify({ version, urls }, null, 2));
      const template = readFileSync(join(config.root, 'scripts/sw-template.js'), 'utf8');
      writeFileSync(
        join(outDir, 'sw.js'),
        template.replace('__VERSION__', version).replace('__URLS__', JSON.stringify([...urls, base + 'asset-manifest.json'])).replace(/__BASE__/g, base),
      );
    },
  };
}
