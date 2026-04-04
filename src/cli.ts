import { parseArgs } from 'node:util';
import { getHttpUrl } from './config.js';
import { httpPost, httpGet, healthCheck } from './http-client.js';

const USAGE = `Usage: opencortex-cli <command> [options]

Commands:
  setup               Interactive setup wizard (configure local/remote mode)
  health              Check server health
  status              Show server status (via HTTP API)
  recall <query>      Search memories
  store <text>        Store a memory
  stats               Show memory statistics
  feedback <uri> <reward>
                     Apply reward feedback to a memory
  decay               Apply reward decay to all memories
  context-recall <query>
                     Test recall via /api/v1/context (prepare phase)
  context-commit <user_msg> <assistant_msg>
                     Test commit via /api/v1/context (commit phase)
  context-end         Test end via /api/v1/context (end phase)
  memory-list        List memories with pagination
  content-read <uri> Read full content of a memory by URI
  promote <uri...>   Promote memories to shared scope
  insights-generate [days]
                     Generate insights report (default: 7 days)
  insights-latest    Get latest insights report
  insights-history [limit]
                     Get insights report history (default: 10)

Options:
  --top-k, -k <n>    Number of results for recall (default: 5)
  --category, -c <s>  Category for store
  --context-type, -t <s> Filter by context type (memory|resource|skill)
  --limit, -l <n>     Page size (default: 50)
  --offset, -o <n>    Pagination offset (default: 0)
  --project-id, -p <s> Project ID for promote
  --session-id, -s <s> Session ID for context commands (default: auto-generated)
  --help, -h          Show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'top-k':        { type: 'string', short: 'k', default: '5' },
      'category':     { type: 'string', short: 'c', default: '' },
      'context-type': { type: 'string', short: 't', default: '' },
      'limit':        { type: 'string', short: 'l', default: '50' },
      'offset':       { type: 'string', short: 'o', default: '0' },
      'project-id':   { type: 'string', short: 'p', default: '' },
      'session-id':   { type: 'string', short: 's', default: '' },
      'help':         { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const cmd = positionals[0];

  if (cmd === 'setup') {
    const { runSetup } = await import('./setup.js');
    await runSetup();
    process.exit(0);
  }

  const httpUrl = getHttpUrl();
  const sessionId = values['session-id'] || `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  switch (cmd) {
    case 'health': {
      const ok = await healthCheck(httpUrl);
      console.log(ok ? 'OK' : 'UNREACHABLE');
      process.exit(ok ? 0 : 1);
      break; // unreachable but satisfies TS
    }
    case 'status': {
      const data = await httpGet(`${httpUrl}/api/v1/system/status?type=health`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'recall': {
      const query = positionals.slice(1).join(' ');
      if (!query) { console.error('Usage: opencortex-cli recall <query>'); process.exit(1); }
      const topK = parseInt(values['top-k']!, 10) || 5;
      const data = await httpPost(`${httpUrl}/api/v1/memory/search`, { query, limit: topK }) as Record<string, unknown>;
      const results = data.results as Array<Record<string, unknown>> | undefined;
      if (results?.length) {
        for (const r of results) {
          console.log(`[${((r.score as number) ?? 0).toFixed(3)}] ${r.abstract || r.uri || '(no title)'}`);
          if (r.content) console.log(`  ${(r.content as string).slice(0, 200)}`);
          console.log();
        }
      } else { console.log('No results.'); }
      break;
    }
    case 'store': {
      const text = positionals.slice(1).join(' ');
      if (!text) { console.error('Usage: opencortex-cli store <text>'); process.exit(1); }
      const payload: Record<string, unknown> = { abstract: text.slice(0, 200), content: text, context_type: 'memory' };
      if (values.category) payload.category = values.category;
      const data = await httpPost(`${httpUrl}/api/v1/memory/store`, payload) as Record<string, unknown>;
      console.log('Stored:', data.uri || 'ok');
      break;
    }
    case 'stats': {
      const data = await httpGet(`${httpUrl}/api/v1/memory/stats`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'feedback': {
      const uri = positionals[1];
      const reward = Number.parseFloat(positionals[2]);
      if (!uri || Number.isNaN(reward)) { console.error('Usage: opencortex-cli feedback <uri> <reward>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/memory/feedback`, { uri, reward });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'decay': {
      const data = await httpPost(`${httpUrl}/api/v1/memory/decay`, {});
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-recall': {
      const query = positionals.slice(1).join(' ');
      if (!query) { console.error('Usage: opencortex-cli context-recall <query>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/context`, {
        session_id: sessionId, phase: 'prepare', turn_id: 't1',
        messages: [{ role: 'user', content: query }],
        config: { max_items: parseInt(values['top-k']!, 10) || 5 },
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-commit': {
      const userMsg = positionals[1], assistantMsg = positionals[2];
      if (!userMsg || !assistantMsg) { console.error('Usage: opencortex-cli context-commit <user_msg> <assistant_msg>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/context`, {
        session_id: sessionId, phase: 'commit', turn_id: 't1',
        messages: [{ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg }],
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-end': {
      const data = await httpPost(`${httpUrl}/api/v1/context`, { session_id: sessionId, phase: 'end' });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'memory-list': {
      const qs = new URLSearchParams();
      if (values.category) qs.set('category', values.category);
      if (values['context-type']) qs.set('context_type', values['context-type']);
      qs.set('limit', values.limit!);
      qs.set('offset', values.offset!);
      const data = await httpGet(`${httpUrl}/api/v1/memory/list?${qs}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'content-read': {
      const uri = positionals.slice(1).join(' ');
      if (!uri) { console.error('Usage: opencortex-cli content-read <uri>'); process.exit(1); }
      const data = await httpGet(`${httpUrl}/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
      const result = (data as Record<string, unknown>).result;
      console.log(typeof result === 'string' ? result : JSON.stringify(data, null, 2));
      break;
    }
    case 'promote': {
      const uris = positionals.slice(1);
      if (!uris.length || !values['project-id']) {
        console.error('Usage: opencortex-cli promote <uri...> --project-id <id>');
        process.exit(1);
      }
      const data = await httpPost(`${httpUrl}/api/v1/memory/promote_to_shared`, {
        uris,
        project_id: values['project-id'],
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-generate': {
      const days = parseInt(positionals[1], 10) || 7;
      const data = await httpPost(`${httpUrl}/api/v1/insights/generate?days=${days}`, {}, 300000);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-latest': {
      const data = await httpGet(`${httpUrl}/api/v1/insights/latest`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-history': {
      const limit = parseInt(positionals[1], 10) || 10;
      const data = await httpGet(`${httpUrl}/api/v1/insights/history?limit=${limit}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch(err => { console.error(`Error: ${(err as Error).message}`); process.exit(1); });
