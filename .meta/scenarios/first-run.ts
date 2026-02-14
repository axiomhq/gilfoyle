import type { IncidentScenario } from '../harness/types.js';

/**
 * First Run Scenario (T10) — No Config, Fresh Install
 *
 * Tests new-user onboarding. The agent activates with zero config.
 * Init output shows setup ran (first run), no deployments configured.
 *
 * The agent must:
 * 1. Run scripts/init → see first-run output with no deployments
 * 2. NOT attempt axiom-query or grafana-query (nothing is configured)
 * 3. Guide the user to configure their observability tools
 * 4. Mention editing config.toml with at least one deployment
 * 5. Tell the user to re-run scripts/init after configuring
 *
 * This scenario has no fixtures — there's nothing to query.
 * The correct behavior is to recognize the unconfigured state
 * and help the user set up, not to blindly attempt queries.
 */

export const firstRunScenario: IncidentScenario = {
  id: 'first-run',
  name: 'First run — no config, fresh install',
  description: 'Brand new user with no config. Agent should guide setup, not attempt queries.',
  prompt: `Our API is returning 500 errors intermittently. Can you investigate?`,
  initOutput: `First Run — Setting Up
======================

Created: /home/user/.config/gilfoyle
Created: /home/user/.config/gilfoyle/memory/kb

Config created: /home/user/.config/gilfoyle/config.toml

⚠️  No deployments configured.

   Edit /home/user/.config/gilfoyle/config.toml and add at least one:

     [axiom.deployments.prod]
     url = "https://api.axiom.co"
     token = "xapt-xxx"
     org_id = "your-org"

     [grafana.deployments.prod]
     url = "https://your-org.grafana.net"
     token = "glsa_xxx"

     [slack.workspaces.work]
     token = "xoxb-xxx"

   Then re-run: scripts/init
`,
  toolMocks: {},
  fixtures: {
    validDeployments: [],
    datasources: [],
    datasets: {},
    metrics: {},
  },
  expected: {
    // The "root cause" here is that there's no config — the agent should say so
    rootCauseMustMention: ['config', 'configure'],
    rootCauseMustNotMention: ['deploy', 'OOM', 'timeout', 'connection', 'redis'],
    requiredEvidence: [],
    requiredQueries: [],
    // No queries should be attempted — scored by FirstRunScorer
  },
  budgets: {
    maxToolCalls: 4, // init + maybe mem-write, nothing else
    maxTotalTokens: 4000,
    maxElapsedMs: 90_000,
  },
  scoring: {
    allowNoQueries: true,
    requireSlackComms: false,
    requireMemoryWrite: false,
    requireMemoryDistillation: false,
    requireHypothesisDiscipline: false,
    requireMustNotMention: false,
  },
};
