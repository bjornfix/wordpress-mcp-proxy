#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load sites configuration
const sitesPath = join(__dirname, "sites.json");
const sites = JSON.parse(readFileSync(sitesPath, "utf-8"));
const siteNames = Object.keys(sites);

// Session cache per site
const sessions = {};

// Create MCP server
const server = new Server(
  {
    name: "wordpress-mcp-proxy",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize session for a site
async function initSession(siteName) {
  const site = sites[siteName];
  if (!site) {
    throw new Error(`Unknown site: ${siteName}. Available: ${siteNames.join(", ")}`);
  }

  const response = await fetch(site.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": site.auth,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "wordpress-mcp-proxy",
          version: "1.0.0",
        },
      },
    }),
  });

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(`No session ID returned for ${siteName}`);
  }

  sessions[siteName] = sessionId;
  return sessionId;
}

// Get or create session for a site
async function getSession(siteName) {
  if (!sessions[siteName]) {
    await initSession(siteName);
  }
  return sessions[siteName];
}

// Helper to make requests to WordPress sites
async function wpRequest(siteName, body) {
  const site = sites[siteName];
  if (!site) {
    throw new Error(`Unknown site: ${siteName}. Available: ${siteNames.join(", ")}`);
  }

  const sessionId = await getSession(siteName);

  const response = await fetch(site.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": site.auth,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    // If session expired, clear it and retry once
    if (text.includes("expired session") || text.includes("Invalid session")) {
      delete sessions[siteName];
      const newSessionId = await getSession(siteName);
      const retryResponse = await fetch(site.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": site.auth,
          "Mcp-Session-Id": newSessionId,
        },
        body: JSON.stringify(body),
      });
      if (!retryResponse.ok) {
        const retryText = await retryResponse.text();
        throw new Error(`WordPress API error (${retryResponse.status}): ${retryText}`);
      }
      return await retryResponse.json();
    }
    throw new Error(`WordPress API error (${response.status}): ${text}`);
  }

  return await response.json();
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_sites",
        description: "List all available WordPress sites",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "discover_abilities",
        description: "Discover all available abilities on a WordPress site",
        inputSchema: {
          type: "object",
          properties: {
            site: {
              type: "string",
              description: `Site name. Available: ${siteNames.join(", ")}`,
            },
          },
          required: ["site"],
        },
      },
      {
        name: "get_ability_info",
        description: "Get detailed information about a specific WordPress ability",
        inputSchema: {
          type: "object",
          properties: {
            site: {
              type: "string",
              description: `Site name. Available: ${siteNames.join(", ")}`,
            },
            ability_name: {
              type: "string",
              description: "The full name of the ability (e.g., 'content/get-post')",
            },
          },
          required: ["site", "ability_name"],
        },
      },
      {
        name: "execute_ability",
        description: "Execute a WordPress ability with the provided parameters",
        inputSchema: {
          type: "object",
          properties: {
            site: {
              type: "string",
              description: `Site name. Available: ${siteNames.join(", ")}`,
            },
            ability_name: {
              type: "string",
              description: "The full name of the ability to execute",
            },
            parameters: {
              type: "object",
              description: "Parameters to pass to the ability",
            },
          },
          required: ["site", "ability_name"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_sites": {
        const siteList = siteNames.map((name) => ({
          name,
          url: sites[name].url.replace("/wp-json/mcp/mcp-adapter-default-server", ""),
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sites: siteList }, null, 2),
            },
          ],
        };
      }

      case "discover_abilities": {
        const result = await wpRequest(args.site, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "mcp-adapter-discover-abilities",
            arguments: {},
          },
        });
        const rawText = result.result?.content?.[0]?.text;
        let parsed = result;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            parsed = { raw: rawText };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2),
            },
          ],
        };
      }

      case "get_ability_info": {
        const result = await wpRequest(args.site, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "mcp-adapter-get-ability-info",
            arguments: {
              ability_name: args.ability_name,
            },
          },
        });
        const rawText = result.result?.content?.[0]?.text;
        let parsed = result;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            parsed = { raw: rawText };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2),
            },
          ],
        };
      }

      case "execute_ability": {
        const result = await wpRequest(args.site, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "mcp-adapter-execute-ability",
            arguments: {
              ability_name: args.ability_name,
              parameters: args.parameters || {},
            },
          },
        });
        const rawText = result.result?.content?.[0]?.text;
        let parsed = result;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            parsed = { raw: rawText };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: error.message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WordPress MCP Proxy running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
