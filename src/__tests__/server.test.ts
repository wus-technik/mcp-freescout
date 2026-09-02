import { FreeScoutAPI } from '../freescout-api.js';
import { TicketAnalyzer } from '../ticket-analyzer.js';
import { createFreeScoutMcpServer } from '../server.js';

describe('createFreeScoutMcpServer', () => {
  it('registers all twelve FreeScout tools', () => {
    const api = new FreeScoutAPI('https://example.test', 'dummy-key');
    const analyzer = new TicketAnalyzer();
    const server = createFreeScoutMcpServer({
      api,
      analyzer,
      defaultUserId: 1,
      version: '0.0.0-test',
    });

    const registered = (
      server as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;

    expect(Object.keys(registered).sort()).toEqual(
      [
        'freescout_add_note',
        'freescout_analyze_ticket',
        'freescout_create_draft_reply',
        'freescout_get_mailboxes',
        'freescout_get_ticket',
        'freescout_get_ticket_context',
        'freescout_get_timelogs',
        'freescout_log_time',
        'freescout_search_tickets',
        'freescout_send_reply',
        'freescout_update_ticket',
        'freescout_whoami',
      ].sort()
    );
  });
});
