#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from 'express';
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

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const analyzer = new TicketAnalyzer();
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: packageJson.version });
});

app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
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
    next(err);
    return;
  }

  const api = new FreeScoutAPI(FREESCOUT_URL!, token);
  const server = createFreeScoutMcpServer({
    api,
    analyzer,
    defaultUserId: DEFAULT_USER_ID,
    version: packageJson.version,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    transport.close().catch(() => {
      /* noop */
    });
    server.close().catch(() => {
      /* noop */
    });
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);

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
