#!/usr/bin/env node

// External imports
import * as dotenv from "dotenv";
import sql from "mssql";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Internal imports
import { UpdateDataTool } from "./tools/UpdateDataTool.js";
import { InsertDataTool } from "./tools/InsertDataTool.js";
import { ReadDataTool } from "./tools/ReadDataTool.js";
import { CreateTableTool } from "./tools/CreateTableTool.js";
import { CreateIndexTool } from "./tools/CreateIndexTool.js";
import { ListTableTool } from "./tools/ListTableTool.js";
import { DropTableTool } from "./tools/DropTableTool.js";
import { DefaultAzureCredential, InteractiveBrowserCredential } from "@azure/identity";
import { DescribeTableTool } from "./tools/DescribeTableTool.js";

// MSSQL Database connection configuration
// const credential = new DefaultAzureCredential();

// Globals for connection and token reuse
let globalSqlPool: sql.ConnectionPool | null = null;
let globalAccessToken: string | null = null;
let globalTokenExpiresOn: Date | null = null;

// Function to create SQL config with configurable authentication method
export async function createSqlConfig(): Promise<{ config: sql.config, token?: string, expiresOn?: Date }> {
  const authMethod = process.env.AUTH_METHOD?.toLowerCase() || 'azure-ad';
  const trustServerCertificate = process.env.TRUST_SERVER_CERTIFICATE?.toLowerCase() === 'true';
  const connectionTimeout = process.env.CONNECTION_TIMEOUT ? parseInt(process.env.CONNECTION_TIMEOUT, 10) : 30;

  const baseConfig = {
    server: process.env.SERVER_NAME!,
    database: process.env.DATABASE_NAME!,
    options: {
      encrypt: true,
      trustServerCertificate,
      useUTC: false
    },
    connectionTimeout: connectionTimeout * 1000, // convert seconds to milliseconds
  };

  switch (authMethod) {
    case 'azure-ad':
    case 'azuread':
      // Azure Active Directory authentication
      const credential = new InteractiveBrowserCredential({
        redirectUri: 'http://localhost'
      });
      const accessToken = await credential.getToken('https://database.windows.net/.default');
      
      return {
        config: {
          ...baseConfig,
          authentication: {
            type: 'azure-active-directory-access-token',
            options: {
              token: accessToken?.token!,
            },
          },
        },
        token: accessToken?.token!,
        expiresOn: accessToken?.expiresOnTimestamp ? new Date(accessToken.expiresOnTimestamp) : new Date(Date.now() + 30 * 60 * 1000)
      };

    case 'windows':
    case 'ntlm':
      // Windows authentication
      return {
        config: {
          ...baseConfig,
          authentication: {
            type: 'ntlm',
            options: {
              domain: process.env.DOMAIN || '',
              userName: process.env.USERNAME || '',
              password: process.env.PASSWORD || ''
            }
          },
        }
      };

    case 'sql':
    case 'sqlserver':
      // SQL Server authentication
      return {
        config: {
          ...baseConfig,
          user: process.env.SQL_USERNAME!,
          password: process.env.SQL_PASSWORD!,
        }
      };

    default:
      throw new Error(`Unsupported authentication method: ${authMethod}. Supported methods: azure-ad, windows, sql`);
  }
}

const updateDataTool = new UpdateDataTool();
const insertDataTool = new InsertDataTool();
const readDataTool = new ReadDataTool();
const createTableTool = new CreateTableTool();
const createIndexTool = new CreateIndexTool();
const listTableTool = new ListTableTool();
const dropTableTool = new DropTableTool();
const describeTableTool = new DescribeTableTool();

const server = new Server(
  {
    name: "mssql-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Read READONLY env variable
const isReadOnly = process.env.READONLY === "true";

// Request handlers

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: isReadOnly
    ? [listTableTool, readDataTool, describeTableTool] // todo: add searchDataTool to the list of tools available in readonly mode once implemented
    : [insertDataTool, readDataTool, describeTableTool, updateDataTool, createTableTool, createIndexTool, dropTableTool, listTableTool], // add all new tools here
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case insertDataTool.name:
        result = await insertDataTool.run(args);
        break;
      case readDataTool.name:
        result = await readDataTool.run(args);
        break;
      case updateDataTool.name:
        result = await updateDataTool.run(args);
        break;
      case createTableTool.name:
        result = await createTableTool.run(args);
        break;
      case createIndexTool.name:
        result = await createIndexTool.run(args);
        break;
      case listTableTool.name:
        result = await listTableTool.run(args);
        break;
      case dropTableTool.name:
        result = await dropTableTool.run(args);
        break;
      case describeTableTool.name:
        if (!args || typeof args.tableName !== "string") {
          return {
            content: [{ type: "text", text: `Missing or invalid 'tableName' argument for describe_table tool.` }],
            isError: true,
          };
        }
        result = await describeTableTool.run(args as { tableName: string });
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error occurred: ${error}` }],
      isError: true,
    };
  }
});

// Server startup
async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Fatal error running server:", error);
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

// Connect to SQL only when handling a request

async function ensureSqlConnection() {
  const authMethod = process.env.AUTH_METHOD?.toLowerCase() || 'azure-ad';
  
  // For Azure AD, check token expiry; for other methods, just check connection
  if (authMethod === 'azure-ad' || authMethod === 'azuread') {
    // If we have a pool and it's connected, and the token is still valid, reuse it
    if (
      globalSqlPool &&
      globalSqlPool.connected &&
      globalAccessToken &&
      globalTokenExpiresOn &&
      globalTokenExpiresOn > new Date(Date.now() + 2 * 60 * 1000) // 2 min buffer
    ) {
      return;
    }
  } else {
    // For Windows and SQL Server auth, just check if connection exists
    if (globalSqlPool && globalSqlPool.connected) {
      return;
    }
  }

  // Get new config (and token if using Azure AD)
  const result = await createSqlConfig();
  const { config } = result;
  
  // Store token info for Azure AD
  if (authMethod === 'azure-ad' || authMethod === 'azuread') {
    globalAccessToken = result.token!;
    globalTokenExpiresOn = result.expiresOn!;
  }

  // Close old pool if exists
  if (globalSqlPool && globalSqlPool.connected) {
    await globalSqlPool.close();
  }

  globalSqlPool = await sql.connect(config);
}

// Patch all tool handlers to ensure SQL connection before running
function wrapToolRun(tool: { run: (...args: any[]) => Promise<any> }) {
  const originalRun = tool.run.bind(tool);
  tool.run = async function (...args: any[]) {
    await ensureSqlConnection();
    return originalRun(...args);
  };
}

[insertDataTool, readDataTool, updateDataTool, createTableTool, createIndexTool, dropTableTool, listTableTool, describeTableTool].forEach(wrapToolRun);