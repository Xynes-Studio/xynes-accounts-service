const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: bun run scripts/run-with-env.ts <bun-subcommand...>

Examples:
  bun run scripts/run-with-env.ts run --watch src/index.ts
  bun run scripts/run-with-env.ts test
  bun run scripts/run-with-env.ts test --integration
  bun run scripts/run-with-env.ts run scripts/test-coverage-gate.ts

Env:
  XYNES_ENV_FILE (default: .env.dev)
  RUN_INTEGRATION_TESTS (default: false)
`);
  process.exit(0);
}

const envFile = process.env.XYNES_ENV_FILE || '.env.dev';
const hasExplicitEnvFile = args.some((arg) => arg === '--env-file' || arg.startsWith('--env-file='));

const wantsIntegration = args.includes('--integration');
const forwardedArgs = args.filter((arg) => arg !== '--integration');

const isTestCommand = forwardedArgs[0] === 'test';
const env = { ...process.env };
if (isTestCommand && wantsIntegration) {
  env.RUN_INTEGRATION_TESTS = 'true';
}

const bunArgs = [process.execPath, ...(hasExplicitEnvFile ? [] : [`--env-file=${envFile}`]), ...forwardedArgs];

const child = Bun.spawn({
  cmd: bunArgs,
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});

const exitCode = await child.exited;
process.exit(exitCode);
