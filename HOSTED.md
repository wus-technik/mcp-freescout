# Hosted / HTTP Transport

This package ships an HTTP entrypoint (`dist/http.js`, bin:
`mcp-freescout-http`) that speaks the MCP Streamable HTTP transport. It is
designed to run inside a shared Docker container while still letting each user
authenticate with their own FreeScout API key, including write actions being
attributed to that authenticated FreeScout user.

## Run with Docker

```bash
docker build -t mcp-freescout-http .
docker run --rm -p 3000:3000 \
  -e FREESCOUT_URL=https://support.example.com \
  mcp-freescout-http
```

The container only knows the FreeScout instance URL. **No API key is configured
at container start.** A `docker-compose.yml` example is included in the repo.

## Authenticate per connection

MCP clients connect to `POST /mcp` and pass the user's FreeScout API key as a
Bearer token:

```text
Authorization: Bearer <user-freescout-api-key>
```

The server uses that key for every FreeScout request it makes on behalf of the
connection, against the fixed `FREESCOUT_URL`. Requests without a valid
`Authorization: Bearer ...` header are rejected with HTTP 401 and a
`WWW-Authenticate: Bearer` challenge.

In hosted mode, write tools are bound to the authenticated API key identity.
If a tool accepts a `userId` field for compatibility with stdio mode, that
field is ignored by the HTTP entrypoint instead of allowing user impersonation.

## Connection methods

### Method 1: Local Docker testing

When the container is running locally with `-p 3000:3000`, the MCP HTTP
endpoint is:

```text
http://localhost:3000/mcp
```

Use this when you want to test the hosted transport from your own machine with
an MCP client or direct HTTP requests.

The client must:

- connect to `http://localhost:3000/mcp`
- use Streamable HTTP transport
- send `Authorization: Bearer <your-freescout-api-key>` on each request

Example test request:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-freescout-api-key>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      }
    }
  }'
```

If you are running the container on another internal host, replace `localhost`
with that host name or IP address and ensure the port is reachable.

### Method 2: Claude remote connector

For Claude, this HTTP server is used as a remote MCP connector. Claude connects
to your MCP server from Anthropic's cloud infrastructure, not from your local
machine.

Important implications:

- `http://localhost:3000/mcp` works for local testing, but not for Claude
- your MCP endpoint must be reachable from the public internet
- the remote endpoint should be your public `/mcp` URL, for example
  `https://mcp.your-domain.com/mcp`

To use this server with Claude:

1. Run the container on a host with a public HTTPS URL.
2. Publish the MCP endpoint so Claude can reach it.
3. In Claude, open `Settings > Connectors`.
4. Add a custom connector that points to your public MCP URL.
5. Authenticate with your FreeScout API key using bearer-token auth when Claude prompts for it.

This server expects:

- Streamable HTTP transport
- endpoint path `/mcp`
- `Authorization: Bearer <your-freescout-api-key>` on requests

## Environment variables

| Variable                    | Required | Default | Description                                 |
| --------------------------- | -------- | ------- | ------------------------------------------- |
| `FREESCOUT_URL`             | yes      | —       | Base URL of the FreeScout instance.         |
| `PORT`                      | no       | `3000`  | HTTP port the server binds to.              |
| `FREESCOUT_DEFAULT_USER_ID` | no       | `1`     | Default `userId` for note/draft operations. |

`FREESCOUT_API_KEY` is **not** read by the HTTP entrypoint. It is supplied per
request via `Authorization: Bearer`.

`FREESCOUT_DEFAULT_USER_ID` remains available so the same shared server factory
can also support stdio mode, but it is not used to override the authenticated
user for hosted HTTP writes.

## Health check

`GET /healthz` returns `{"status":"ok","version":"..."}` for use as a
container or orchestrator health probe. The bundled Docker image also defines a
`HEALTHCHECK` that polls this endpoint.
