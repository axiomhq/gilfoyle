import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseJudgeOutput } from '../scorers/judge-output.js';

const evidenceJudgeSchema = z.object({
  specificity: z.number(),
  discrimination: z.number(),
  contextualization: z.number(),
  explanation: z.string(),
});

async function main(): Promise<void> {
  // Regression: Gemini often emits object-like JSON with trailing commas,
  // code fences, or broken explanation strings. We should still recover core
  // numeric judgments instead of falling back immediately.
  const trailingCommaPayload = `
\`\`\`json
{
  "specificity": 84,
  "discrimination": 71,
  "contextualization": 65,
  "explanation": "Specific metrics were cited",
}
\`\`\`
`;

  const truncatedExplanationPayload = `
{
  "specificity": 93,
  "discrimination": 88,
  "contextualization": 77,
  "explanation": "Agent cited exact values and
`;

  const trailingComma = parseJudgeOutput(evidenceJudgeSchema, trailingCommaPayload);
  assert.equal(trailingComma.specificity, 84);
  assert.equal(trailingComma.discrimination, 71);
  assert.equal(trailingComma.contextualization, 65);

  const truncated = parseJudgeOutput(evidenceJudgeSchema, truncatedExplanationPayload);
  assert.equal(truncated.specificity, 93);
  assert.equal(truncated.discrimination, 88);
  assert.equal(truncated.contextualization, 77);

  console.log('gemini judge parse regression checks passed');
}

await main();
