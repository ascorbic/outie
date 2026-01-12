// Web search tools using Brave Search API

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

export interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
  news?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
}

// Search the web using Brave Search API
export async function searchWeb(
  query: string,
  apiKey: string,
  options: { count?: number; freshness?: string } = {},
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(options.count ?? 5),
  });

  if (options.freshness) {
    params.set("freshness", options.freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status}`);
  }

  const data = (await response.json()) as BraveSearchResponse;

  return (
    data.web?.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    })) ?? []
  );
}

// Search news using Brave Search API
export async function searchNews(
  query: string,
  apiKey: string,
  options: { count?: number; freshness?: string } = {},
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(options.count ?? 5),
  });

  if (options.freshness) {
    params.set("freshness", options.freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/news/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status}`);
  }

  const data = (await response.json()) as BraveSearchResponse;

  return (
    data.news?.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    })) ?? []
  );
}

// Web search tools for the agent
export const WEB_SEARCH_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web for information. Use this to find current information, answer questions about recent events, or research topics.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        count: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "news_search",
    description:
      "Search for recent news articles. Use this to find current events, breaking news, or recent developments on a topic.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The news search query",
        },
        count: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
];
