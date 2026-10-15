// Vercel's Node runtime cannot require() ES modules, which ripple-binary-codec's dependency tree does.
// Bundle the XRPL merchant runtime (everything except pg, which is plain CommonJS) into one ESM file.
import { build } from 'esbuild';
await build({
  entryPoints: ['dist/integrations/xrpl-runtime-entry.js'], outfile: 'dist/xrpl-runtime.bundle.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['pg'], legalComments: 'none',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
