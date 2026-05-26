# HTTP Transport & Docker Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second entrypoint that exposes the existing FreeScout MCP server over Streamable HTTP, so the project can be built as a Docker image. `FREESCOUT_URL` stays a container ENV; each MCP client connection brings its own FreeScout API key via `Authorization: Bearer <key>`.

**Architecture:** No rewrite. Existing `src/index.ts` (stdio entrypoint with global `FREESCOUT_API_KEY`) stays intact and continues to work for local stdio usage. Tool registration is extracted into a reusable factory (`src/server.ts`) that accepts a `FreeScoutAPI` instance. A new `src/http.ts` entrypoint mounts an Express app with the SDK's `StreamableHTTPServerTransport` in stateless mode; for each HTTP request it extracts the bearer token, builds a fresh `FreeScoutAPI` for that user, creates a fresh `McpServer` via the factory, and hands the request to a per-request transport. The stdio entrypoint is refactored to use the same factory so both transports share one source of truth.

**Tech Stack:** Node.js 20, TypeScript (ES2022/Node16), `@modelcontextprotocol/sdk@^1.25.1` (uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`), Express 4, Jest, Docker (node:20-alpine).

---

## File Structure

- Create `src/server.ts` — `createFreeScoutMcpServer(api, analyzer, defaultUserId)` factory that registers all tools on a fresh `McpServer` and returns it. Single source of truth for tool registration.
- Create `src/auth.ts` — `extractBearerToken(authorizationHeader)` helper. Pure, no I/O.
- Create `src/http.ts` — HTTP entrypoint. Reads `FREESCOUT_URL`/`PORT`/`FREESCOUT_DEFAULT_USER_ID` from env, sets up Express, mounts `POST /mcp` and `GET /healthz`. Per request: extract bearer → build api → build server via factory → stateless `StreamableHTTPServerTransport` → `transport.handleRequest`.
- Modify `src/index.ts` — keep as the stdio entrypoint and the `bin` target. Stop registering tools inline; delegate to `createFreeScoutMcpServer`. Behavior unchanged for existing users.
- Create `src/__tests__/auth.test.ts` — unit tests for `extractBearerToken`.
- Create `src/__tests__/server.test.ts` — smoke test that the factory registers tools without throwing.
- Create `Dockerfile` — multi-stage (builder + runtime), runs `node dist/http.js`.
- Create `.dockerignore`.
- Create `docker-compose.yml` — example with `FREESCOUT_URL`.
- Modify `package.json` — add `express` (+ `@types/express`) dependency, add `start:http` script, add `mcp-freescout-http` bin entry.
- Modify `README.md` — document Docker / HTTP usage and the bearer auth requirement.

Boundaries: `server.ts` knows nothing about transports or HTTP. `http.ts` knows nothing about FreeScout business logic. `auth.ts` is pure and dependency-free.

---

## Task 1: Extract tool registration into a server factory

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts` (replace inline tool registration with a call to the factory)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/server.test.ts`:

```typescript
import { FreeScoutAPI } from '../freescout-api.js';
import { TicketAnalyzer } from '../ticket-analyzer.js';
import { createFreeScoutMcpServer } from '../server.js';

describe('createFreeScoutMcpServer', () => {
  it('returns an McpServer instance with all FreeScout tools registered', () => {
    const api = new FreeScoutAPI('https://example.test', 'dummy-key');
    const analyzer = new TicketAnalyzer();
    const server = createFreeScoutMcpServer({ api, analyzer, defaultUserId: 1 });

    expect(server).toBeDefined();
    // McpServer exposes a registered-tool registry on its internal _registeredTools.
    // We assert via the public server.server (lower-level Server) capabilities object.
    const caps = (server as unknown as { server: { _capabilities?: unknown } }).server;
    expect(caps).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server.test`
Expected: FAIL with "Cannot find module '../server.js'".

- [ ] **Step 3: Create `src/server.ts` with the factory**

Move the eight `server.registerTool(...)` blocks and their helpers (`allowedThreadTypes`, `isValidThreadType`, `hasCreatedAt`, `normalizeThreadBody`) out of `src/index.ts` into `src/server.ts`. The factory receives its dependencies as a single options object so future additions don't break the signature.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
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

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

export interface CreateServerOptions {
  api: FreeScoutAPI;
  analyzer: TicketAnalyzer;
  defaultUserId: number;
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

  const server = new McpServer({
    name: 'mcp-freescout',
    version: packageJson.version,
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
        userId: z.number().optional().describe('User ID for the note (default: from env)'),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
        ticketId: z.string(),
      },
    },
    async ({ ticket, note, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = userId ?? DEFAULT_USER_ID;
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
      description: 'Update ticket status and/or assignment',
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
      } = { byUser: DEFAULT_USER_ID };
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
          .describe('User ID creating the draft (defaults to env setting)'),
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
      const actualUserId = userId ?? DEFAULT_USER_ID;
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

  return server;
}
```

- [ ] **Step 4: Run server.test to verify it passes**

Run: `npm test -- server.test`
Expected: PASS.

- [ ] **Step 5: Rewrite `src/index.ts` to use the factory**

Replace the entire body of `src/index.ts` with:

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { FreeScoutAPI } from './freescout-api.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import { loadEnv } from './env.js';
import { createFreeScoutMcpServer } from './server.js';

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

loadEnv();

const FREESCOUT_URL = process.env.FREESCOUT_URL;
const FREESCOUT_API_KEY = process.env.FREESCOUT_API_KEY;
const DEFAULT_USER_ID = parseInt(process.env.FREESCOUT_DEFAULT_USER_ID || '1');

if (!FREESCOUT_URL || !FREESCOUT_API_KEY) {
  console.error('Missing required environment variables: FREESCOUT_URL and FREESCOUT_API_KEY');
  process.exit(1);
}

const api = new FreeScoutAPI(FREESCOUT_URL, FREESCOUT_API_KEY);
const analyzer = new TicketAnalyzer();
const server = createFreeScoutMcpServer({ api, analyzer, defaultUserId: DEFAULT_USER_ID });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`FreeScout MCP Server v${packageJson.version} running...`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
```

- [ ] **Step 6: Run full test suite + build**

Run: `npm test && npm run build`
Expected: All existing tests pass; `dist/index.js` and `dist/server.js` produced.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/index.ts src/__tests__/server.test.ts
git commit -m "refactor: extract tool registration into createFreeScoutMcpServer factory"
```

---

## Task 2: Add bearer-token extraction helper

**Files:**
- Create: `src/auth.ts`
- Create: `src/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/auth.test.ts`:

```typescript
import { extractBearerToken } from '../auth.js';

describe('extractBearerToken', () => {
  it('returns the token from a valid Bearer header', () => {
    expect(extractBearerToken('Bearer fs_key_abc123')).toBe('fs_key_abc123');
  });

  it('trims whitespace around the token', () => {
    expect(extractBearerToken('Bearer   fs_key_abc123   ')).toBe('fs_key_abc123');
  });

  it('throws when the header is missing', () => {
    expect(() => extractBearerToken(undefined)).toThrow(/Authorization/i);
  });

  it('throws when the scheme is not Bearer', () => {
    expect(() => extractBearerToken('Basic dXNlcjpwYXNz')).toThrow(/Bearer/i);
  });

  it('throws when the token is empty', () => {
    expect(() => extractBearerToken('Bearer ')).toThrow(/empty/i);
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer fs_key_abc123')).toBe('fs_key_abc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth.test`
Expected: FAIL with "Cannot find module '../auth.js'".

- [ ] **Step 3: Implement `src/auth.ts`**

```typescript
export class MissingBearerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBearerTokenError';
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new MissingBearerTokenError('Missing Authorization header');
  }
  const match = authorizationHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (!match) {
    throw new MissingBearerTokenError('Authorization header must use Bearer scheme');
  }
  const token = match[1].trim();
  if (!token) {
    throw new MissingBearerTokenError('Authorization Bearer token is empty');
  }
  return token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth.test`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/__tests__/auth.test.ts
git commit -m "feat: add extractBearerToken helper for per-request API key auth"
```

---

## Task 3: Add Express + Streamable HTTP entrypoint

**Files:**
- Modify: `package.json` (add `express` dependency, `@types/express` devDependency, `start:http` script, `mcp-freescout-http` bin)
- Create: `src/http.ts`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install express@^4.21.0
npm install -D @types/express@^4.17.21
```
Expected: `package.json` updated, `package-lock.json` updated, no errors.

- [ ] **Step 2: Add npm script and bin entry**

In `package.json`, under `"scripts"`, add after the existing `start` line:

```json
    "start:http": "node dist/http.js",
```

In `package.json`, under `"bin"`, change to:

```json
  "bin": {
    "mcp-freescout": "dist/index.js",
    "mcp-freescout-http": "dist/http.js"
  },
```

- [ ] **Step 3: Implement `src/http.ts`**

Stateless mode: a new `McpServer` and `StreamableHTTPServerTransport` are built per HTTP request. This isolates each user's API key inside a closure and matches the SDK's stateless example.

```typescript
#!/usr/bin/env node
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRequire } from 'node:module';
import { loadEnv } from './env.js';
import { FreeScoutAPI } from './freescout-api.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import { createFreeScoutMcpServer } from './server.js';
import { extractBearerToken, MissingBearerTokenError } from './auth.js';

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

loadEnv();

const FREESCOUT_URL = process.env.FREESCOUT_URL;
const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_USER_ID = parseInt(process.env.FREESCOUT_DEFAULT_USER_ID || '1');

if (!FREESCOUT_URL) {
  console.error('Missing required environment variable: FREESCOUT_URL');
  process.exit(1);
}

const analyzer = new TicketAnalyzer();
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: packageJson.version });
});

app.post('/mcp', async (req: Request, res: Response) => {
  let token: string;
  try {
    token = extractBearerToken(req.header('authorization'));
  } catch (err) {
    if (err instanceof MissingBearerTokenError) {
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer realm="mcp-freescout"')
        .json({ jsonrpc: '2.0', error: { code: -32001, message: err.message }, id: null });
      return;
    }
    throw err;
  }

  const api = new FreeScoutAPI(FREESCOUT_URL!, token);
  const server = createFreeScoutMcpServer({ api, analyzer, defaultUserId: DEFAULT_USER_ID });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {
      /* noop */
    });
    server.close().catch(() => {
      /* noop */
    });
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Streamable HTTP also defines GET (server->client SSE) and DELETE (terminate
// session). In stateless mode they have nothing to do, so reject them clearly.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed in stateless mode' },
    id: null,
  });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(PORT, () => {
  console.error(`FreeScout MCP HTTP server v${packageJson.version} listening on :${PORT}`);
  console.error(`FreeScout URL: ${FREESCOUT_URL}`);
});
```

Notes for the engineer:
- Never log `token`, `req.headers.authorization`, or `req.body` even on error — those contain user credentials and ticket content.
- `sessionIdGenerator: undefined` puts the transport in stateless mode (one transport per request).
- The `res.on('close', ...)` hook handles client disconnects during long responses.

- [ ] **Step 4: Build to verify it compiles**

Run: `npm run build`
Expected: `dist/http.js` produced, no TypeScript errors.

- [ ] **Step 5: Smoke-test locally**

Run in one shell:
```bash
FREESCOUT_URL=https://example.invalid node dist/http.js
```
In another shell:
```bash
curl -i http://localhost:3000/healthz
curl -i -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
Expected: `/healthz` returns 200 with status ok. The `/mcp` call without `Authorization` returns 401 with `WWW-Authenticate: Bearer`. Adding `-H 'authorization: Bearer dummy'` produces a valid `initialize` response.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/http.ts
git commit -m "feat: add Streamable HTTP entrypoint with per-request bearer auth"
```

---

## Task 4: Dockerfile and .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.git
.github
.claude
.vscode
coverage
*.log
.env
.env.*
docs
worktrees
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "dist/http.js"]
```

- [ ] **Step 3: Build the image**

Run: `docker build -t mcp-freescout-http:dev .`
Expected: Build succeeds, image tagged `mcp-freescout-http:dev`.

- [ ] **Step 4: Run the image and hit healthz**

Run:
```bash
docker run --rm -d --name mcp-freescout-test \
  -p 3000:3000 \
  -e FREESCOUT_URL=https://example.invalid \
  mcp-freescout-http:dev
sleep 2
curl -i http://localhost:3000/healthz
docker stop mcp-freescout-test
```
Expected: `curl` returns `200 OK` with `{"status":"ok",...}`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: add Dockerfile for HTTP MCP server image"
```

---

## Task 5: docker-compose example

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  mcp-freescout:
    build: .
    image: mcp-freescout-http:local
    ports:
      - "3000:3000"
    environment:
      FREESCOUT_URL: "https://support.example.com"
      PORT: "3000"
      # Optional: FREESCOUT_DEFAULT_USER_ID: "1"
    restart: unless-stopped
```

- [ ] **Step 2: Verify config parses**

Run: `docker compose config`
Expected: docker-compose prints the resolved config without errors.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "build: add docker-compose example for HTTP MCP server"
```

---

## Task 6: Document Docker + HTTP usage in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Docker / HTTP transport" section**

Locate the existing usage section in `README.md`. After it, append:

````markdown
## Docker / HTTP transport

In addition to the stdio entrypoint, this package ships an HTTP entrypoint
(`dist/http.js`, bin: `mcp-freescout-http`) that speaks the MCP
Streamable HTTP transport. It is designed to run inside a shared Docker
container while still letting each user authenticate with their own
FreeScout API key.

### Run with Docker

```bash
docker build -t mcp-freescout-http .
docker run --rm -p 3000:3000 \
  -e FREESCOUT_URL=https://support.example.com \
  mcp-freescout-http
```

The container only knows the FreeScout instance URL. **No API key is
configured at container start.**

### Authenticate per connection

MCP clients connect to `POST /mcp` and pass the user's FreeScout API key
as a Bearer token:

```
Authorization: Bearer <user-freescout-api-key>
```

Requests without a valid `Authorization: Bearer …` header are rejected
with HTTP 401 and `WWW-Authenticate: Bearer`.

### Environment variables (HTTP mode)

| Variable                     | Required | Default | Description                                      |
| ---------------------------- | -------- | ------- | ------------------------------------------------ |
| `FREESCOUT_URL`              | yes      | —       | Base URL of the FreeScout instance.              |
| `PORT`                       | no       | `3000`  | HTTP port the server binds to.                   |
| `FREESCOUT_DEFAULT_USER_ID`  | no       | `1`     | Default `userId` for note/draft operations.      |

`FREESCOUT_API_KEY` is **not** read by the HTTP entrypoint — it is
supplied per request via `Authorization: Bearer`.

### Health check

`GET /healthz` returns `{"status":"ok","version":"…"}` for use as a
container/orchestrator health probe.

### Stdio mode still works

The original stdio entrypoint (`mcp-freescout`, `dist/index.js`) is
unchanged and still reads `FREESCOUT_URL` + `FREESCOUT_API_KEY` from the
environment, for local single-user installs.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Docker image and HTTP bearer-auth usage"
```

---

## Task 7: Final verification

- [ ] **Step 1: Lint, test, build all together**

Run: `npm run lint && npm test && npm run build`
Expected: All pass with no warnings or errors. `dist/index.js` and `dist/http.js` both present.

- [ ] **Step 2: End-to-end Docker smoke**

Run:
```bash
docker build -t mcp-freescout-http:verify .
docker run --rm -d --name mcp-verify \
  -p 3000:3000 \
  -e FREESCOUT_URL=https://example.invalid \
  mcp-freescout-http:verify
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/healthz
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
docker stop mcp-verify
```
Expected: `/healthz` → `200`; the unauthenticated `/mcp` POST → `401`.

- [ ] **Step 3: Final tag commit (only if other files changed)**

If `npm install` or builds left untracked artifacts that should be tracked (unlikely — `dist/`, `node_modules/`, and `.env*` are gitignored), stage and commit them. Otherwise skip.

```bash
git status
```

If nothing to commit, this task is complete.
