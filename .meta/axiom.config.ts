import { defineConfig } from 'axiom/ai/config';

export default defineConfig({
  eval: {
    url: process.env.AXIOM_URL,
    token: process.env.AXIOM_TOKEN,
    dataset: process.env.AXIOM_DATASET ?? 'gilfoyle-evals',
    include: ['**/*.eval.ts'],
    exclude: ['node_modules/**'],
    timeoutMs: 120_000,
  },
});
