# WordPress MCP Proxy

MCP server that proxies requests to multiple WordPress sites running the [MCP Expose Abilities](https://github.com/bjornfix/mcp-expose-abilities) plugin.

## About

Learn more about MCP Expose Abilities: https://devenia.com/plugins/mcp-expose-abilities/

## Requirements

- Node.js 18+
- WordPress sites with MCP Expose Abilities plugin installed
- Application passwords for authentication

## Setup

1. Clone the repository
2. Copy `sites.example.json` to `sites.json`
3. Configure your sites with their MCP endpoints and Basic auth credentials
4. Install dependencies: `npm install`
5. Run: `node index.js` (stdio default) or enable HTTP mode (see below)

## Configuration

Edit `sites.json` to add your WordPress sites:

```json
{
  "my-site": {
    "url": "https://example.com/wp-json/mcp/mcp-adapter-default-server",
    "auth": "Basic <base64_encoded_username:app_password>"
  }
}
```

To generate the auth value:
```bash
echo -n "username:application_password" | base64
```

## Transports

The proxy supports two transports:

- `stdio` (default): local process or SSH-based connection
- `http`: streamable HTTP server for remote clients

### HTTP Mode

Run the proxy as an HTTP server:

```bash
MCP_PROXY_TRANSPORT=http \
MCP_PROXY_HOST=0.0.0.0 \
MCP_PROXY_PORT=8787 \
MCP_PROXY_TOKEN="replace-with-strong-token" \
node index.js
```

Optional environment variables:

- `MCP_PROXY_ALLOWED_HOSTS` (comma-separated list of allowed hostnames)
- `MCP_PROXY_LOG=1` to emit startup logs

## Client Configuration (HTTP recommended)

### Claude Code

`~/.config/claude-code/mcp_settings.json`:

```json
{
  "mcpServers": {
    "wordpress-proxy": {
      "type": "http",
      "url": "http://YOUR_HOST:8787/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.wordpress-proxy]
type = "http"
url = "http://YOUR_HOST:8787/mcp"
headers = { Authorization = "Bearer YOUR_TOKEN" }
```

### cc-switch (single source of truth)

Add `wordpress-proxy` as an HTTP MCP server in cc-switch and enable it for both
Claude and Codex. Then remove per-app overrides so cc-switch remains the source
of truth.

## Stdio Integration (optional)

Add to your global MCP config:

```bash
claude mcp add wordpress-proxy -s user -- node /path/to/index.js
```

Or via SSH to a remote server:

```bash
claude mcp add wordpress-proxy -s user -- ssh myserver "node /opt/wordpress-mcp-proxy/index.js"
```

## Available Tools

- `list_sites` - List all configured WordPress sites
- `discover_abilities` - Discover available abilities on a site
- `get_ability_info` - Get details about a specific ability
- `execute_ability` - Execute an ability with parameters

## License

MIT
