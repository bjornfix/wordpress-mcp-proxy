# WordPress MCP Proxy

MCP server that proxies requests to multiple WordPress sites running the [MCP Expose Abilities](https://github.com/Jeremypress/mcp-expose-abilities) plugin.

## Requirements

- Node.js 18+
- WordPress sites with MCP Expose Abilities plugin installed
- Application passwords for authentication

## Setup

1. Clone the repository
2. Copy `sites.example.json` to `sites.json`
3. Configure your sites with their MCP endpoints and Basic auth credentials
4. Install dependencies: `npm install`
5. Run: `node index.js`

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

## Claude Code Integration

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
