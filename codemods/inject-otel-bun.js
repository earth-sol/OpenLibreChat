/**
 * codemods/inject-otel-bun.js
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1. Insert OTEL imports at the top
  const firstImp = root.find(j.ImportDeclaration).at(0);
  [
    ['NodeSDK', '@opentelemetry/sdk-node'],
    ['getNodeAutoInstrumentations', '@opentelemetry/auto-instrumentations-node'],
    ['OTLPTraceExporter', '@opentelemetry/exporter-trace-otlp-http'],
    ['Resource', '@opentelemetry/resources'],
    ['SemanticResourceAttributes', '@opentelemetry/semantic-conventions']
  ].forEach(([sym, mod]) => {
    firstImp.insertBefore(
      j.importDeclaration(
        [j.importSpecifier(j.identifier(sym))],
        j.literal(mod)
      )
    );
  });

  // 2. Inject Bun-native OTEL init IIFE
  firstImp.insertBefore(
    j.template.statement(`
(async () => {
  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: Bun.env.OTEL_SERVICE_NAME || 'OpenLibreChat-API'
    }),
    traceExporter: new OTLPTraceExporter({
      url: Bun.env.OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
    }),
    instrumentations: [getNodeAutoInstrumentations()]
  });
  await sdk.start();
  console.log('✅ OpenTelemetry initialized');
})();
    `)
  );

  return root.toSource({ quote: 'single', trailingComma: true });
}