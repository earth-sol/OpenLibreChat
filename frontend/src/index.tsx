import PluginLoader from './plugin-runtime/PluginLoader';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PluginLoader from './plugin-runtime/PluginLoader';
import './index.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <PluginLoader>
      <PluginLoader><App /></PluginLoader>
    </PluginLoader>
  </React.StrictMode>
);
