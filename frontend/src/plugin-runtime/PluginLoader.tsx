import React, { ReactNode, useEffect, useState } from 'react';
import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace
} from '@opentelemetry/api';
import {
  WebTracerProvider
} from '@opentelemetry/sdk-trace-web';
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter
} from '@opentelemetry/sdk-trace-base';

interface PluginManifest {
  id: string;
  ui: string;    // e.g. "ui.js"
  url: string;   // e.g. "/plugins/example-plugin"
  order?: number;
}

const PluginLoader: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [manifests, setManifests] = useState<PluginManifest[]>([]);

  useEffect(() => {
    // ——— 1) OpenTelemetry setup ———
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    const provider = new WebTracerProvider({
      // default spanProcessors
    });
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    provider.register();
    const tracer = trace.getTracer('plugin-loader');

    // ——— 2) Expose global APIs ———
    window.__pluginApis = {};
    window.registerMyPlugin = (id, api) => {
      window.__pluginApis[id] = api;
    };
    window.toolApi = {
      invoke: (toolId, args) =>
        fetch(`/api/v1/tools/${toolId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }).then(r => r.json())
    };
    window.libreChat = {
      config: (window as any).__LIBRECHAT_CONFIG__ || {},
      getVersion: () => (window as any).__LIBRECHAT_VERSION__ || '0.7.7',
      getUser: () => (window as any).__LIBRECHAT_USER__ || { id: '', name: '' },
    };
    window.ragApi = {
      ingest: (conversationId, fileIds) => {
        const url = `${window.libreChat.config.RAG_API_URL}/ingest`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId, file_ids: fileIds }),
        }).then(r => r.json());
      },
      query: (conversationId, query, top_k = 4) => {
        const url = `${window.libreChat.config.RAG_API_URL}/query`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId, query, top_k }),
        }).then(r => r.json());
      }
    };
    window.reloadPlugin = (id: string) => {
      setManifests(prev => [...prev]);
    };

    // ——— 3) Load manifests ———
    fetch('/api/plugins')
      .then(r => r.json())
      .then((list: PluginManifest[]) => {
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        setManifests(list);
      })
      .catch(err => console.error('Failed to fetch plugin manifests', err));
  }, []);

  return (
    <>
      {children}
      {manifests.map(manifest => {
        const tracer = trace.getTracer('plugin-run');
        const span = tracer.startSpan(`load-plugin-${manifest.id}`);

        const Component = React.lazy(() =>
          import(`${manifest.url}/${manifest.ui}?t=${Date.now()}`)
            .then(mod => {
              span.setStatus({ code: 1 }); // OK
              span.end();
              return mod;
            })
            .catch(err => {
              span.recordException(err);
              span.setStatus({ code: 2, message: err.message });
              span.end();
              console.error(`Plugin ${manifest.id} failed to load`, err);
              return { default: () => null };
            })
        );

        return (
          <React.Suspense key={manifest.id} fallback={null}>
            <Component />
          </React.Suspense>
        );
      })}
    </>
  );
};

export default PluginLoader;