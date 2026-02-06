/**
 * Synthesizer Types
 *
 * Seed → Blueprint → ScenarioFixtures pipeline types.
 */

// ─── Seed (what humans write) ────────────────────────────────────────────

export type IncidentArchetype =
  | 'resource_exhaustion'    // OOM, disk full, pool exhaustion
  | 'bad_deploy'             // config change, bad code, regression
  | 'dependency_failure'     // upstream/downstream service failure
  | 'data_corruption'        // bad writes, schema drift
  | 'traffic_spike'          // DDoS, viral event, cron storm
  | 'certificate_expiry'     // TLS, auth token expiry
  | 'network_partition'      // DNS, connectivity, split-brain
  | 'resource_leak';         // connection leak, goroutine leak, fd leak

export interface ScenarioSeed {
  id: string;
  name: string;
  archetype: IncidentArchetype;

  topology: {
    services: string[];
    primaryFaultService: string;
    affectedServices: string[];
  };

  rootCause: {
    mechanism: string;        // "redis session keys created without TTL"
    category: 'config' | 'code' | 'dependency' | 'capacity' | 'infra';
    components: string[];     // ['redis', 'session-service']
    mustSurfaceClues: string[]; // concepts that must appear in data
  };

  alertPrompt: string;        // what the on-call human sees

  difficulty: {
    stepsToRootCause: number; // 2-5: how many query rounds to reach RCA
    signalBuriedness: number; // 0-3: 0=obvious, 3=needle-in-haystack
    redHerringCount: number;  // unrelated suspicious events
  };

  messiness: {
    fieldWidth: [number, number]; // target fields per row [min, max]
    nullRate: number;             // 0-1
    jsonEncodedRate: number;      // 0-1: values that are stringified JSON
    casingDrift: number;          // 0-1: how often field names have wrong case
    aliasRate: number;            // 0-1: same concept under different field names
  };

  timeRangeMinutes: number;
  variations: number;
}

// ─── Blueprint (what the LLM generates) ──────────────────────────────────

export interface BlueprintEvent {
  tsOffsetSec: number;         // relative to scenario start
  dataset: string;             // 'app-logs', 'redis-logs', etc.
  service?: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attributes: Record<string, unknown>;
  role: 'breadcrumb' | 'rootcause' | 'background' | 'red_herring';
  clueId?: string;
}

export interface BlueprintMetric {
  name: string;
  labels: Record<string, string>;
  shape: 'baseline' | 'spike' | 'ramp' | 'step_up' | 'step_down' | 'sawtooth';
  baselineValue: number;
  peakValue: number;
  changeOffsetSec: number;     // when the shape changes relative to scenario start
  role: 'symptom' | 'rootcause' | 'background' | 'red_herring';
}

export interface InvestigationStep {
  clueId: string;
  description: string;         // what the agent should discover
  probeQueries: {
    axiom?: { dataset: string; mustContain: string[] }[];
    grafana?: { metricName: string }[];
  };
}

export interface ScenarioBlueprint {
  seed: ScenarioSeed;
  datasets: string[];
  datasources: { uid: string; name: string; type: string }[];
  deployments: string[];
  events: BlueprintEvent[];
  metrics: BlueprintMetric[];
  investigationPath: InvestigationStep[];
  expected: {
    rootCauseMustMention: string[];
    rootCauseMustNotMention: string[];
    requiredQueries: {
      tool: 'scripts/axiom-query' | 'scripts/grafana-query';
      mustMatch: string;
      description: string;
    }[];
  };
}
