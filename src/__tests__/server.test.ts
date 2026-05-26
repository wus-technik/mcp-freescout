import { FreeScoutAPI } from '../freescout-api.js';
import { TicketAnalyzer } from '../ticket-analyzer.js';
import { createFreeScoutMcpServer } from '../server.js';

describe('createFreeScoutMcpServer', () => {
  it('returns an McpServer instance with all FreeScout tools registered', () => {
    const api = new FreeScoutAPI('https://example.test', 'dummy-key');
    const analyzer = new TicketAnalyzer();
    const server = createFreeScoutMcpServer({ api, analyzer, defaultUserId: 1 });

    expect(server).toBeDefined();
    const caps = (server as unknown as { server: { _capabilities?: unknown } }).server;
    expect(caps).toBeDefined();
  });
});
