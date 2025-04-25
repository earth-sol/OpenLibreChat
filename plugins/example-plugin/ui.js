(async function() {
  try {
    // — Register a simple API that uses Tools under the hood
    window.registerMyPlugin('example-plugin', {
      greet: name => `Hello, ${name}!`,
      echoTool: msg => window.toolApi.invoke('echo-tool', { message: msg })
    });

    // — Render a floating greet button
    const btn = document.createElement('button');
    btn.innerText = '👋 Greet';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '1rem',
      left: '1rem',
      zIndex: 9999
    });
    btn.onclick = () => {
      const greeting = window.__pluginApis['example-plugin'].greet('LibreChat');
      alert(greeting);
    };
    document.body.appendChild(btn);
  } catch (err) {
    console.error('example-plugin init failed', err);
  }
})();
