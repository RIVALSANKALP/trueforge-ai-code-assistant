import { TrueForge } from '@truefoundry/trueforge-sdk';
import { HealthProbe } from '../connection/HealthProbe.js';
import { McpSmokeTest } from '../mcp/McpSmokeTest.js';

async function main(): Promise<void> {
  const baseUrl = 'http://localhost:8790';
  const workspaceRoot = process.cwd();

  console.log('=================================================================');
  console.log('       TrueForge VS Code Extension — Phase 1 Smoke Test          ');
  console.log('=================================================================');
  console.log(`Target TrueForge Server: ${baseUrl}`);
  console.log(`Active Workspace Root:   ${workspaceRoot}`);
  console.log(`Execution Timestamp:     ${new Date().toISOString()}\n`);

  // 1. Connectivity & Health Check
  console.log('[STAGE 1] Testing TrueForge Server Health...');
  const client = new TrueForge({
    baseUrl,
    timeoutInSeconds: 30,
    maxRetries: 2
  });

  const probe = new HealthProbe(client, baseUrl);
  const healthResult = await probe.checkHealth();

  if (healthResult.ok) {
    console.log('>>> TrueForge Health Check: SUCCESS');
    console.log('Capabilities received:', JSON.stringify(healthResult.capabilities, null, 2));
  } else {
    console.error('>>> TrueForge Health Check: FAILED');
    console.error(`Error: ${healthResult.error} (Status: ${healthResult.statusCode})`);
    process.exit(1);
  }

  // 2. Execute 7-Step MCP Smoke Test
  console.log('\n[STAGE 2] Executing 7-Step MCP Smoke Test...');
  const smokeTest = new McpSmokeTest(client, workspaceRoot, (msg) => {
    console.log(msg);
  });

  const runResult = await smokeTest.execute();

  console.log('\n=================================================================');
  console.log('                     Smoke Test Summary                          ');
  console.log('=================================================================');
  console.log(`Instance ID:     ${runResult.instanceId}`);
  console.log(`Server Name:     ${runResult.serverName}`);
  console.log(`Overall Success: ${runResult.success ? 'PASSED' : 'BLOCKED / FAILED'}`);
  if (runResult.blocker) {
    console.log(`Blocker Reason:  ${runResult.blocker}`);
  }

  console.log('\nSteps Detail:');
  for (const step of runResult.steps) {
    const icon = step.status === 'passed' ? '✓' : step.status === 'blocked' ? '✗' : '-';
    console.log(`  [${icon}] Step ${step.step}: ${step.name} [${step.status.toUpperCase()}]`);
    console.log(`      Detail: ${step.detail}`);
  }

  console.log('=================================================================\n');

  if (!runResult.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during smoke test runner execution:', err);
  process.exit(1);
});
