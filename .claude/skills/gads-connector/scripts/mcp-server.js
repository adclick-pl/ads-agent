import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';

import { 
  listAccounts, 
  getCampaigns, 
  getKeywords, 
  getSearchTerms,
  getKeywordIdeas,
  getBudgets,
  runRawQuery
} from './queries.js';
import { 
  updateCampaignStatus, 
  updateCampaignBudget, 
  addCampaignNegativeKeywords, 
  addAccountNegativePlacements 
} from './mutator.js';

const server = new Server(
  {
    name: 'google-ads-agent-connector',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tool List
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'gads_list_accounts',
        description: 'Lists all customer accounts managed by the target login MCC account.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { 
              type: 'string', 
              description: 'Optional 10-digit customer ID to start listing child accounts. (Dashes will be removed).' 
            }
          }
        }
      },
      {
        name: 'gads_get_campaigns',
        description: 'Retrieves campaign-level metrics (clicks, cost, impressions, conversions, conversion_value, ctr, cpc, roas) over a date range.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            days: { type: 'number', description: 'Date range in days (default: 30).' }
          },
          required: ['customerId']
        }
      },
      {
        name: 'gads_get_keywords',
        description: 'Retrieves performance metrics and quality scores for all keywords in the account.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            days: { type: 'number', description: 'Date range in days (default: 30).' }
          },
          required: ['customerId']
        }
      },
      {
        name: 'gads_get_search_terms',
        description: 'Retrieves user queries/search terms with metrics, perfect for negative keyword identification.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            days: { type: 'number', description: 'Date range in days (default: 30).' },
            minCost: { type: 'number', description: 'Filter search terms with a minimum cost standard currency (default: 0).' }
          },
          required: ['customerId']
        }
      },
      {
        name: 'gads_keyword_ideas',
        description: 'Keyword research via Google Keyword Planner (generateKeywordIdeas). Returns avg monthly searches, competition and top-of-page bid range from seed keywords and/or a URL. Provide keywords and/or url.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID (required even for research).' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Seed keywords.' },
            url: { type: 'string', description: 'Seed landing page URL (instead of/with keywords).' },
            geoTargetId: { type: 'string', description: 'geoTargetConstant ID (default 2616 = Poland).' },
            languageId: { type: 'string', description: 'languageConstant ID (default 1030 = Polish).' },
            network: { type: 'string', enum: ['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS'], description: 'Search network (default GOOGLE_SEARCH).' },
            pageSize: { type: 'number', description: 'Max ideas to return (default 1000).' }
          },
          required: ['customerId']
        }
      },
      {
        name: 'gads_get_budgets',
        description: 'Retrieves all active campaign budgets and daily amounts.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' }
          },
          required: ['customerId']
        }
      },
      {
        name: 'gads_execute_query',
        description: 'Executes a raw GAQL (Google Ads Query Language) search query and returns cleaned results.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            query: { type: 'string', description: 'Standard GAQL search query.' }
          },
          required: ['customerId', 'query']
        }
      },
      {
        name: 'gads_update_campaign_status',
        description: 'Enables or Pauses a campaign.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            campaignId: { type: 'string', description: 'Google Ads campaign numerical ID.' },
            status: { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'New campaign status.' },
            dryRun: { type: 'boolean', description: 'If true, simulates the mutation (default: false).' }
          },
          required: ['customerId', 'campaignId', 'status']
        }
      },
      {
        name: 'gads_update_budget',
        description: 'Modifies campaign daily budget. Blocked by SafetyLimits if the change exceeds the threshold (default 40%); pass force:true to override.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            budgetId: { type: 'string', description: 'Google Ads budget numerical ID.' },
            amountStandard: { type: 'number', description: 'New budget amount in standard float currency.' },
            dryRun: { type: 'boolean', description: 'If true, simulates the mutation (default: false).' },
            force: { type: 'boolean', description: 'Override the SafetyLimits block for a large budget change (default: false).' }
          },
          required: ['customerId', 'budgetId', 'amountStandard']
        }
      },
      {
        name: 'gads_add_negative_keywords',
        description: 'Adds list of negative keywords to a specified campaign.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            campaignId: { type: 'string', description: 'Google Ads campaign numerical ID.' },
            keywords: { 
              type: 'array', 
              items: { type: 'string' }, 
              description: 'Array of negative keyword text. Default broad match. For other matches pass objects or parse them in mutator.' 
            },
            dryRun: { type: 'boolean', description: 'If true, simulates the mutation (default: false).' }
          },
          required: ['customerId', 'campaignId', 'keywords']
        }
      },
      {
        name: 'gads_add_negative_placements',
        description: 'Adds placement exclusions (spam domains) on account level.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: '10-digit Google Ads account ID.' },
            domains: { 
              type: 'array', 
              items: { type: 'string' }, 
              description: 'Array of domain strings to exclude (e.g. ["spam.net", "clickfarm.org"]).' 
            },
            dryRun: { type: 'boolean', description: 'If true, simulates the mutation (default: false).' }
          },
          required: ['customerId', 'domains']
        }
      }
    ]
  };
});

// Handle Tool Executions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let data;

    switch (name) {
      case 'gads_list_accounts':
        data = await listAccounts(args?.customerId);
        break;
      case 'gads_get_campaigns':
        data = await getCampaigns(args.customerId, args.days);
        break;
      case 'gads_get_keywords':
        data = await getKeywords(args.customerId, args.days);
        break;
      case 'gads_get_search_terms':
        data = await getSearchTerms(args.customerId, args.days, args.minCost);
        break;
      case 'gads_keyword_ideas':
        data = await getKeywordIdeas(args.customerId, {
          keywords: args.keywords,
          url: args.url,
          geoTargetId: args.geoTargetId,
          languageId: args.languageId,
          network: args.network,
          pageSize: args.pageSize,
        });
        break;
      case 'gads_get_budgets':
        data = await getBudgets(args.customerId);
        break;
      case 'gads_execute_query':
        data = await runRawQuery(args.customerId, args.query);
        break;
      case 'gads_update_campaign_status':
        data = await updateCampaignStatus(args.customerId, args.campaignId, args.status, !!args.dryRun);
        break;
      case 'gads_update_budget':
        data = await updateCampaignBudget(args.customerId, args.budgetId, args.amountStandard, !!args.dryRun, undefined, { force: !!args.force });
        break;
      case 'gads_add_negative_keywords':
        data = await addCampaignNegativeKeywords(args.customerId, args.campaignId, args.keywords, !!args.dryRun);
        break;
      case 'gads_add_negative_placements':
        data = await addAccountNegativePlacements(args.customerId, args.domains, !!args.dryRun);
        break;
      default:
        throw new Error(`Tool not found: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: error.message
        }
      ]
    };
  }
});

// Run Standard IO Transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🤖 Google Ads Agent Connector MCP Server is running...');
}

run().catch(err => {
  console.error('Fatal MCP error:', err);
  process.exit(1);
});
