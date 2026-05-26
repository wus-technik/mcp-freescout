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
const server = createFreeScoutMcpServer({
  api,
  analyzer,
  defaultUserId: DEFAULT_USER_ID,
  version: packageJson.version,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`FreeScout MCP Server v${packageJson.version} running...`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
