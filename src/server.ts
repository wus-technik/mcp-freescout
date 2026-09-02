import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  resolveDraftReplyRecipients,
  shouldInheritDraftRecipients,
} from './draft-recipients.js';
import { FreeScoutAPI } from './freescout-api.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import {
  TicketAnalysisSchema,
  SearchFiltersSchema,
  type FreeScoutRecipients,
} from './types.js';

export interface CreateServerOptions {
  api: FreeScoutAPI;
  analyzer: TicketAnalyzer;
  defaultUserId: number;
  userBinding?: 'default' | 'authenticated';
  /** Server version to advertise. */
  version: string;
}

const allowedThreadTypes = new Set(['customer', 'message', 'note']);
type ThreadType = 'customer' | 'message' | 'note';

const isValidThreadType = (type: unknown): type is ThreadType =>
  typeof type === 'string' && allowedThreadTypes.has(type as ThreadType);

const hasCreatedAt = (createdAt: unknown): createdAt is string =>
  typeof createdAt === 'string' && createdAt.length > 0;

const normalizeThreadBody = (body: unknown) => (typeof body === 'string' ? body : '');

export function createFreeScoutMcpServer(opts: CreateServerOptions): McpServer {
  const { api, analyzer, defaultUserId: DEFAULT_USER_ID } = opts;
  const userBinding = opts.userBinding ?? 'default';
  const usesAuthenticatedUser = userBinding === 'authenticated';

  const noteUserDescription = usesAuthenticatedUser
    ? 'Ignored in hosted mode; the authenticated FreeScout API key determines the author.'
    : 'User ID for the note (default: from env)';
  const draftUserDescription = usesAuthenticatedUser
    ? 'Ignored in hosted mode; the authenticated FreeScout API key determines the draft author.'
    : 'User ID creating the draft (defaults to env setting)';
  const sendUserDescription = usesAuthenticatedUser
    ? 'Ignored in hosted mode; the authenticated FreeScout API key determines the sender.'
    : 'User ID sending the reply (defaults to env setting)';
  const logTimeUserDescription = usesAuthenticatedUser
    ? 'Ignored in hosted mode; the authenticated FreeScout API key determines the user the time is logged against.'
    : 'User ID the time is logged against (defaults to env setting)';

  // FreeScout's API requires an explicit numeric `user` id on every note/message
  // thread it creates, even when the request is authenticated with a per-user
  // API key - it does not infer the acting user from the Bearer token.
  const resolveActingUserId = async (userId?: number): Promise<number | undefined> => {
    if (usesAuthenticatedUser) {
      const me = (await api.getCurrentUser()) as { id: number };
      return me.id;
    }
    return userId ?? DEFAULT_USER_ID;
  };
  const updateDescription = usesAuthenticatedUser
    ? 'Update ticket status and/or assignment as the authenticated FreeScout API user'
    : 'Update ticket status and/or assignment';

  const server = new McpServer({
    name: 'mcp-freescout',
    version: opts.version,
  });

  // --- Tool 1: Get Ticket ---
  server.registerTool(
    'freescout_get_ticket',
    {
      title: 'Get FreeScout Ticket',
      description: 'Fetch and analyze a FreeScout ticket by ID or URL',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        includeThreads: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include all conversation threads'),
      },
    },
    async ({ ticket, includeThreads }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, includeThreads ?? true);
      return { content: [{ type: 'text', text: JSON.stringify(conversation, null, 2) }] };
    }
  );

  // --- Tool 2: Analyze Ticket ---
  server.registerTool(
    'freescout_analyze_ticket',
    {
      title: 'Analyze FreeScout Ticket',
      description:
        'Analyze a FreeScout ticket to determine issue type, root cause, and suggested solution',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      },
      outputSchema: TicketAnalysisSchema,
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);
      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
        structuredContent: analysis,
      };
    }
  );

  // --- Tool 3: Add Note ---
  server.registerTool(
    'freescout_add_note',
    {
      title: 'Add Note to Ticket',
      description: 'Add an internal note to a FreeScout ticket',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        note: z.string().describe('The note content to add'),
        userId: z.number().optional().describe(noteUserDescription),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
      },
    },
    async ({ ticket, note, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = await resolveActingUserId(userId);
      await api.addThread(ticketId, 'note', note, actualUserId);
      const output = {
        success: true,
        message: `Note added to ticket #${ticketId}`,
        ticketId,
      };
      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // --- Tool 4: Update Ticket ---
  server.registerTool(
    'freescout_update_ticket',
    {
      title: 'Update Ticket Status/Assignment',
      description: updateDescription,
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        status: z
          .enum(['active', 'pending', 'closed', 'spam'])
          .optional()
          .describe('New ticket status'),
        assignTo: z.number().optional().describe('User ID to assign the ticket to'),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
      },
    },
    async ({ ticket, status, assignTo }) => {
      const ticketId = api.parseTicketInput(ticket);
      const updates: {
        status?: 'active' | 'pending' | 'closed' | 'spam';
        assignTo?: number;
        byUser?: number;
      } = {};
      if (!usesAuthenticatedUser) {
        updates.byUser = DEFAULT_USER_ID;
      }
      if (status) updates.status = status;
      if (assignTo) updates.assignTo = assignTo;
      await api.updateConversation(ticketId, updates);
      const output = {
        success: true,
        message: `Ticket #${ticketId} updated successfully`,
        ticketId,
      };
      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // --- Tool 5: Create Draft Reply ---
  server.registerTool(
    'freescout_create_draft_reply',
    {
      title: 'Create Draft Reply',
      description: 'Create a draft reply in FreeScout that can be edited before sending',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        replyText: z.string().describe('The draft reply content (generated by the LLM)'),
        userId: z
          .number()
          .optional()
          .describe(draftUserDescription),
        to: z
          .array(z.string().email())
          .optional()
          .describe('Optional TO recipients. Omit to preserve existing recipients; pass [] to clear.'),
        cc: z
          .array(z.string().email())
          .optional()
          .describe('Optional CC recipients. Omit to preserve existing recipients; pass [] to clear.'),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe('Optional BCC recipients. Omit to preserve existing recipients; pass [] to clear.'),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
        draftId: z.number(),
      },
    },
    async ({ ticket, replyText, userId, to, cc, bcc }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = await resolveActingUserId(userId);
      const requestedRecipients: FreeScoutRecipients = { to, cc, bcc };
      let recipientWarning: string | null = null;

      let inheritedRecipients: FreeScoutRecipients = {};
      if (shouldInheritDraftRecipients(requestedRecipients)) {
        try {
          const conversation = await api.getConversation(ticketId, false);
          inheritedRecipients = {
            to: conversation.to,
            cc: conversation.cc,
            bcc: conversation.bcc,
          };
        } catch {
          recipientWarning =
            'Unable to load existing recipients, so FreeScout default recipients were used for omitted fields.';
        }
      }

      const resolvedRecipients = resolveDraftReplyRecipients(
        requestedRecipients,
        inheritedRecipients
      );

      const draftThread = await api.createDraftReply(
        ticketId,
        replyText,
        actualUserId,
        resolvedRecipients
      );

      const output = {
        success: true,
        message: `Draft reply created successfully in FreeScout ticket #${ticketId}`,
        ticketId,
        draftId: draftThread.id,
      };

      return {
        content: [
          {
            type: 'text',
            text: `✅ ${output.message}\n\nDraft ID: ${draftThread.id}\n\nThe draft reply is now saved in FreeScout and can be reviewed, edited, and sent from the FreeScout interface.${recipientWarning ? `\n\nWarning: ${recipientWarning}` : ''}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // --- Tool 5b: Send Reply ---
  server.registerTool(
    'freescout_send_reply',
    {
      title: 'Send Reply',
      description:
        'Send a real reply to a FreeScout ticket, emailing the customer immediately. Requires confirm:true.',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        replyText: z.string().describe('The reply content to send (generated by the LLM)'),
        confirm: z
          .boolean()
          .describe('Must be explicitly true. This sends a real email to the customer and cannot be undone.'),
        userId: z
          .number()
          .optional()
          .describe(sendUserDescription),
        to: z
          .array(z.string().email())
          .optional()
          .describe('Optional TO recipients. Omit to preserve existing recipients; pass [] to clear.'),
        cc: z
          .array(z.string().email())
          .optional()
          .describe('Optional CC recipients. Omit to preserve existing recipients; pass [] to clear.'),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe('Optional BCC recipients. Omit to preserve existing recipients; pass [] to clear.'),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
        threadId: z.number(),
      },
    },
    async ({ ticket, replyText, confirm, userId, to, cc, bcc }) => {
      if (confirm !== true) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Refusing to send: this emails a real customer. Pass confirm: true to actually send.',
            },
          ],
        };
      }

      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = await resolveActingUserId(userId);
      const requestedRecipients: FreeScoutRecipients = { to, cc, bcc };
      let recipientWarning: string | null = null;

      let inheritedRecipients: FreeScoutRecipients = {};
      if (shouldInheritDraftRecipients(requestedRecipients)) {
        try {
          const conversation = await api.getConversation(ticketId, false);
          inheritedRecipients = {
            to: conversation.to,
            cc: conversation.cc,
            bcc: conversation.bcc,
          };
        } catch {
          recipientWarning =
            'Unable to load existing recipients, so FreeScout default recipients were used for omitted fields.';
        }
      }

      const resolvedRecipients = resolveDraftReplyRecipients(
        requestedRecipients,
        inheritedRecipients
      );

      const sentThread = await api.sendReply(
        ticketId,
        replyText,
        actualUserId,
        resolvedRecipients
      );

      const output = {
        success: true,
        message: `Reply sent to the customer on FreeScout ticket #${ticketId}`,
        ticketId,
        threadId: sentThread.id,
      };

      return {
        content: [
          {
            type: 'text',
            text: `✅ ${output.message}${recipientWarning ? `\n\nWarning: ${recipientWarning}` : ''}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // --- Tool 5c: Log Time ---
  server.registerTool(
    'freescout_log_time',
    {
      title: 'Log Time on Ticket',
      description: 'Log time spent on a FreeScout ticket (requires the Time Tracking module)',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        durationMinutes: z.number().positive().describe('Time spent, in minutes'),
        userId: z
          .number()
          .optional()
          .describe(logTimeUserDescription),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
      },
    },
    async ({ ticket, durationMinutes, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = await resolveActingUserId(userId);
      const durationSeconds = Math.round(durationMinutes * 60);
      await api.logTime(ticketId, durationSeconds, actualUserId);
      const output = {
        success: true,
        message: `Logged ${durationMinutes} minute(s) on ticket #${ticketId}`,
        ticketId,
      };
      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // --- Tool 5d: Get Timelogs ---
  server.registerTool(
    'freescout_get_timelogs',
    {
      title: 'Get Timelogs',
      description:
        'List logged time entries, optionally filtered by ticket, user, and/or date range (requires the Time Tracking module)',
      inputSchema: {
        ticket: z
          .string()
          .optional()
          .describe('Ticket ID, ticket number, or FreeScout URL to filter by'),
        userId: z.number().optional().describe('Filter by user ID'),
        from: z
          .string()
          .optional()
          .describe('Only entries on or after this date. ISO date or relative like "7d", "24h".'),
        to: z
          .string()
          .optional()
          .describe('Only entries on or before this date. ISO date or relative like "7d", "24h".'),
        page: z.number().optional().describe('Page number'),
        pageSize: z.number().optional().describe('Page size (defaults to 50)'),
      },
    },
    async ({ ticket, userId, from, to, page, pageSize }) => {
      const conversationId = ticket ? api.parseTicketInput(ticket) : undefined;
      const results = await api.getTimelogs({ conversationId, userId, from, to, page, pageSize });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  // --- Tool 6: Get Ticket Context ---
  server.registerTool(
    'freescout_get_ticket_context',
    {
      title: 'Get Ticket Context',
      description: 'Get ticket context and customer info to help draft personalized replies',
      inputSchema: {
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      },
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);

      const threads = conversation._embedded?.threads || [];
      const safeThreads = threads.filter(
        (t) => isValidThreadType(t.type) && hasCreatedAt(t.created_at)
      );
      const customerMessages = safeThreads.filter((t) => t.type === 'customer');
      const teamMessages = safeThreads.filter(
        (t) => t.type === 'message' || t.type === 'note'
      );

      const context = {
        ticketId,
        customer: { name: analysis.customerName, email: analysis.customerEmail },
        subject: conversation.subject,
        status: conversation.status,
        issueDescription: analysis.issueDescription,
        customerMessages: customerMessages.map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 500) + (stripped.length > 500 ? '...' : '');
          })(),
        })),
        teamMessages: teamMessages.slice(-3).map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');
          })(),
        })),
        analysis: {
          isBug: analysis.isBug,
          isThirdPartyIssue: analysis.isThirdPartyIssue,
          testedByTeam: analysis.testedByTeam,
          rootCause: analysis.rootCause,
        },
      };

      return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
    }
  );

  // --- Tool 7: Search Tickets ---
  server.registerTool(
    'freescout_search_tickets',
    {
      title: 'Search FreeScout Tickets',
      description:
        'Search for FreeScout tickets with explicit filter parameters. Use assignee: "unassigned" for unassigned tickets, or assignee: number for specific user. Supports relative time filters like "7d", "24h". Use includeLastMessage: true to get a preview of the most recent message for each ticket.',
      inputSchema: SearchFiltersSchema,
    },
    async (filters) => {
      const results = await api.searchConversations(filters);
      const conversations = results._embedded?.conversations || [];

      let conversationsWithPreview = conversations;
      if (filters.includeLastMessage && conversations.length > 0) {
        conversationsWithPreview = await Promise.all(
          conversations.map(async (conv) => {
            try {
              const fullConv = await api.getConversation(String(conv.id), true);
              const threads = fullConv._embedded?.threads || [];
              const messages = threads
                .filter((t) => t.type === 'customer' || t.type === 'message')
                .filter((t) => hasCreatedAt(t.created_at));
              const sortedMessages = messages.sort((a, b) => {
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
              });
              const lastMessage = sortedMessages[0];
              if (lastMessage) {
                const body = normalizeThreadBody(lastMessage.body);
                const stripped = analyzer.stripHtml(body);
                const preview =
                  stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');
                return {
                  ...conv,
                  lastMessage: {
                    type: lastMessage.type,
                    date: lastMessage.created_at,
                    preview,
                  },
                };
              }
            } catch {
              /* ignore preview failure */
            }
            return conv;
          })
        );
      }

      const output = {
        conversations: conversationsWithPreview,
        totalCount: results.page?.total_elements || 0,
        page: results.page?.number,
        totalPages: results.page?.total_pages,
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }
  );

  // --- Tool 8: Get Mailboxes ---
  server.registerTool(
    'freescout_get_mailboxes',
    {
      title: 'Get Mailboxes',
      description: 'Get list of available mailboxes',
      inputSchema: {},
    },
    async () => {
      const mailboxes = await api.getMailboxes();
      return { content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }] };
    }
  );

  // --- Tool 9: Whoami ---
  server.registerTool(
    'freescout_whoami',
    {
      title: 'Get Current FreeScout User',
      description:
        'Get the identity of the FreeScout user the configured API key belongs to. Requires a per-user API key; fails with a clear error on legacy shared keys.',
      inputSchema: {},
    },
    async () => {
      const me = await api.getCurrentUser();
      return { content: [{ type: 'text', text: JSON.stringify(me, null, 2) }] };
    }
  );

  return server;
}
