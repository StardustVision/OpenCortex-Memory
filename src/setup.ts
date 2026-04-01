import { createInterface, type Interface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MCP_CONFIG, writeMcpConfig } from './config.js';
import { healthCheck } from './http-client.js';
import type { McpConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_PATH = join(__dirname, 'server.mjs');

function createRL(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, answer => resolve(answer.trim()));
    rl.once('close', () => resolve(''));
  });
}

async function askChoice(rl: Interface, question: string, choices: string[]): Promise<string> {
  const labels = choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n');
  while (true) {
    const answer = await ask(rl, `${question}\n${labels}\n> `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
    console.log(`Please enter 1-${choices.length}.`);
  }
}

export async function runSetup(): Promise<void> {
  const rl = createRL();

  try {
    console.log('\n=== OpenCortex Setup ===\n');

    const mode = await askChoice(rl, 'Select mode:', ['local', 'remote']) as McpConfig['mode'];
    const config: Partial<McpConfig> = { ...DEFAULT_MCP_CONFIG, mode };

    if (mode === 'remote') {
      const url = await ask(rl, `Server URL [${DEFAULT_MCP_CONFIG.remote.http_url}]: `);
      if (url) config.remote = { http_url: url };
      const token = await ask(rl, 'JWT token: ');
      if (token) config.token = token;
    } else {
      const port = await ask(rl, `HTTP port [${DEFAULT_MCP_CONFIG.local.http_port}]: `);
      if (port) {
        const parsed = parseInt(port, 10);
        config.local = { http_port: Number.isFinite(parsed) ? parsed : DEFAULT_MCP_CONFIG.local.http_port };
        if (!Number.isFinite(parsed)) console.log(`Invalid port "${port}", using default ${DEFAULT_MCP_CONFIG.local.http_port}`);
      }
      const token = await ask(rl, 'JWT token (optional, press Enter to skip): ');
      if (token) config.token = token;
    }

    const configPath = writeMcpConfig(config);
    console.log(`\nConfig saved to ${configPath}`);

    const httpUrl = mode === 'remote'
      ? (config.remote?.http_url || DEFAULT_MCP_CONFIG.remote.http_url)
      : `http://127.0.0.1:${config.local?.http_port || DEFAULT_MCP_CONFIG.local.http_port}`;

    process.stdout.write(`Testing connection to ${httpUrl} ... `);
    const ok = await healthCheck(httpUrl);
    console.log(ok ? 'OK' : 'UNREACHABLE (you can configure the server later)');

    let registerClaude = 'no';
    try {
      registerClaude = await askChoice(rl, '\nRegister as Claude Code user-level MCP server? (all projects will have access)', ['yes', 'no']);
    } catch { /* readline closed */ }

    if (registerClaude === 'yes') {
      try {
        const cmdArgs = ['mcp', 'add', '-s', 'user', 'opencortex', '-e', `OPENCORTEX_MODE=${mode}`];
        if (config.token) cmdArgs.push('-e', `OPENCORTEX_TOKEN=${config.token}`);
        if (mode === 'remote' && config.remote?.http_url) cmdArgs.push('-e', `OPENCORTEX_HTTP_URL=${config.remote.http_url}`);
        if (mode === 'local' && config.local?.http_port) cmdArgs.push('-e', `OPENCORTEX_HTTP_PORT=${config.local.http_port}`);
        cmdArgs.push('--', 'node', MCP_SERVER_PATH);
        console.log(`\nRunning: claude ${cmdArgs.join(' ')}`);
        execFileSync('claude', cmdArgs, { stdio: 'inherit' });
        console.log('Registered successfully.');
      } catch { console.log('Failed to register. You can run the command manually later.'); }
    }

    console.log('\n=== Setup Complete ===');
    console.log(`  Mode:   ${mode}`);
    console.log(`  Server: ${httpUrl}`);
    console.log(`  Config: ${configPath}`);
    if (ok) {
      console.log('\nReady to use. Start a new Claude Code session to activate.\n');
    } else if (mode === 'local') {
      console.log('\nServer not reachable. Start the local server first:');
      console.log(`  uv run opencortex-server --host 127.0.0.1 --port ${config.local?.http_port || DEFAULT_MCP_CONFIG.local.http_port}`);
      console.log('\nOr via Docker:\n  docker compose up -d');
      console.log('\nThen verify with:\n  npx opencortex-cli health\n');
    } else {
      console.log('\nServer not reachable yet. Check your remote server, then verify with:\n  npx opencortex-cli health\n');
    }
  } finally {
    rl.close();
  }
}
