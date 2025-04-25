// client/src/plugin-runtime/PluginLoader.tsx
import React, { useEffect, useState, createContext, useContext } from 'react';
import { usePluginApi, registerPlugin } from 'librechat-ui';

interface ServerConfig {
  pluginServer: { staticPrefix: string; pluginsDir: string };
  api: { manifestRoute: string; configRoute: string };
}

// Context for server config
const ConfigContext = createContext<ServerConfig | null>(null);
export const useServerConfig = () => {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error('ServerConfig missing');
  return cfg;
};

const Loader: React.FC = ({ children }) => {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const pluginApi = usePluginApi();

  // Fetch server config at startup
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then((cfg: ServerConfig) => setConfig(cfg))
      .catch(console.error);
  }, []);

  if (!config) return <div>Loading configuration…</div>;

  // Expose registerMyPlugin globally
  window.loadPlugin = async (id: string, url: string) => {
    const mod = await import(/* @vite-ignore */ url);
    if (mod.default) mod.default({ pluginApi });
  };

  return (
    <ConfigContext.Provider value={config}>
      {children}
    </ConfigContext.Provider>
  );
};

// Main wrapper
const PluginLoaderWrapper: React.FC = () => {
  const { api } = useServerConfig();
  const [manifests, setManifests] = useState<any[]>([]);

  // Poll for plugin manifests
  useEffect(() => {
    const fetchManifests = () =>
      fetch(api.manifestRoute)
        .then(res => res.json())
        .then(setManifests)
        .catch(console.error);

    fetchManifests();
    const id = setInterval(fetchManifests, 30_000);                             // configurable polling  [oai_citation:10‡Medium](https://medium.com/%40laidrivm/what-i-learned-by-building-a-static-website-with-bun-elysia-and-jsx-in-2024-dac7d4d19521?utm_source=chatgpt.com)
    return () => clearInterval(id);
  }, [api.manifestRoute]);

  return (
    <>
      {manifests.map(m => (
        <React.Fragment key={m.id}>
          {window.loadPlugin(m.id, m.url)}
        </React.Fragment>
      ))}
    </>
  );
};

export default () => (
  <Loader>
    <PluginLoaderWrapper />
  </Loader>
);

// Register in LibreChat UI (if needed)
registerPlugin({
  id: 'plugin-loader',
  settingsComponent: null, // could hook in a SettingsPanel later
  render: () => <PluginLoaderWrapper />
});