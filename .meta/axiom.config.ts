import { defineConfig } from 'axiom/ai/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { initAxiomAI } from 'axiom/ai';

export default defineConfig({
  eval: {
    url: process.env.AXIOM_URL ?? 'https://api.axiom.co',
    token: process.env.AXIOM_TOKEN,
    dataset: process.env.AXIOM_DATASET,
    orgId: process.env.AXIOM_ORG_ID,
    timeoutMs: parseInt(process.env.EVAL_TIMEOUT_MS ?? '', 10) || 600000,

    instrumentation: ({ url, token, dataset }) => {
      const exporter = new OTLPTraceExporter({
        url: `${url}/v1/traces`,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Axiom-Dataset': dataset,
        },
      });

      const sdk = new NodeSDK({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: 'gilfoyle-evals',
        }),
        spanProcessor: new BatchSpanProcessor(exporter),
      });

      sdk.start();

      const tracer = trace.getTracer('gilfoyle-evals');
      initAxiomAI({ tracer });

      // biome-ignore lint/complexity/useLiteralKeys: accessing private SDK internals
      return { provider: sdk['_tracerProvider'] };
    },
  },
});
