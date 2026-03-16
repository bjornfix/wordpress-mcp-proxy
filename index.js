#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load sites configuration
const sitesPath = join(__dirname, "sites.json");
const sites = JSON.parse(readFileSync(sitesPath, "utf-8"));
const siteNames = Object.keys(sites);

// Session cache per site
const sessions = {};

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

  const isSessionError = (message) =>
    typeof message === "string" &&
    (message.includes("expired session") || message.includes("Invalid session"));

  const retryWithFreshSession = async () => {
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
    const retryJson = await retryResponse.json();
    if (retryJson?.error?.message) {
      throw new Error(`WordPress API error (${retryResponse.status}): ${JSON.stringify(retryJson)}`);
    }
    return retryJson;
  };

  if (!response.ok) {
    const text = await response.text();
    // If session expired, clear it and retry once
    if (isSessionError(text)) {
      return await retryWithFreshSession();
    }
    throw new Error(`WordPress API error (${response.status}): ${text}`);
  }

  const json = await response.json();
  if (json?.error?.message) {
    if (isSessionError(json.error.message)) {
      return await retryWithFreshSession();
    }
    throw new Error(`WordPress API error (${response.status}): ${JSON.stringify(json)}`);
  }

  return json;
}

function createServer() {
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
                description: "The full name of the ability (e.g., content/get-post)",
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

  return server;
}

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (process.env.MCP_PROXY_LOG) {
    console.error("WordPress MCP Proxy running on stdio");
  }
}

async function startHttp() {
  const host = process.env.MCP_PROXY_HOST || "127.0.0.1";
  const port = process.env.MCP_PROXY_PORT ? parseInt(process.env.MCP_PROXY_PORT, 10) : 8787;
  const token = process.env.MCP_PROXY_TOKEN || "";
  const jsonLimit = process.env.MCP_PROXY_JSON_LIMIT || "96mb";
  const allowedHosts = (process.env.MCP_PROXY_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const app = express();
  app.disable("x-powered-by");

  if (allowedHosts.length) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    const localhostHosts = ["127.0.0.1", "localhost", "::1"];
    if (localhostHosts.includes(host)) {
      app.use(localhostHostValidation());
    } else if (host === "0.0.0.0" || host === "::") {
      console.warn(
        `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
          "Consider using the allowedHosts option to restrict allowed hosts, " +
          "or use authentication to protect your server."
      );
    }
  }

  if (token) {
    app.use("/mcp", (req, res, next) => {
      const authHeader = req.headers.authorization || "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : "";
      const queryToken = typeof req.query.token === "string" ? req.query.token : "";

      if (bearerToken === token || queryToken === token) {
        return next();
      }

      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Unauthorized",
        },
        id: null,
      });
    });
  }

  app.use(
    express.json({
      limit: jsonLimit,
    })
  );

  app.use("/mcp", (error, req, res, next) => {
    if (!error) {
      return next();
    }

    if (error.type === "entity.too.large") {
      res.status(413).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Request body exceeds MCP proxy JSON limit (${jsonLimit}).`,
        },
        id: null,
      });
      return;
    }

    if (error instanceof SyntaxError) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Invalid JSON request body.",
        },
        id: null,
      });
      return;
    }

    next(error);
  });

  const transports = new Map();

  app.all("/mcp", async (req, res) => {
    const sessionId = Array.isArray(req.headers["mcp-session-id"])
      ? req.headers["mcp-session-id"][0]
      : req.headers["mcp-session-id"];

    try {
      const isInit = req.method === "POST" && isInitializeRequest(req.body);

      if (isInit) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });

        const server = createServer();
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports.has(sid)) {
            transports.delete(sid);
          }
          server.close();
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && !transports.has(sessionId)) {
        const transport = new StreamableHTTPServerTransport();

        const server = createServer();
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports.has(sid)) {
            transports.delete(sid);
          }
          server.close();
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport();

      const server = createServer();
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          transports.delete(sid);
        }
        server.close();
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.listen(port, host, (error) => {
    if (error) {
      console.error("Failed to start HTTP server:", error);
      process.exit(1);
    }
    if (process.env.MCP_PROXY_LOG) {
      console.error(`WordPress MCP Proxy listening on http://${host}:${port}/mcp`);
    }
  });
}

async function main() {
  const transportMode = process.env.MCP_PROXY_TRANSPORT || "stdio";
  if (transportMode === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
