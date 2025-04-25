export {};

declare global {
  interface Window {
    // Plugin registry
    registerMyPlugin: (id: string, api: any) => void;
    __pluginApis: Record<string, any>;
    // Invoke LibreChat Tools
    toolApi: {
      invoke: (toolId: string, args: Record<string, any>) => Promise<any>;
    };
    // Core LibreChat helpers
    libreChat: {
      config: Record<string, any>;
      getVersion: () => string;
      getUser: () => { id: string; name: string };
    };
    // RAG API
    ragApi: {
      ingest: (conversationId: string, fileIds: string[]) => Promise<any>;
      query: (
        conversationId: string,
        query: string,
        top_k?: number
      ) => Promise<any>;
    };
    // Reload a specific plugin at runtime
    reloadPlugin: (id: string) => void;
  }
}
