// Example extension. Copy this folder to <state>/extensions/hello-panel and run install_extension({id:"hello-panel"}).
module.exports = {
  tools: [
    {
      name: 'hello_count', description: 'Increment the shared counter and greet someone.',
      parameters: { type: 'object', properties: { who: { type: 'string' } } }, risk: 'low', summary: (a) => `Greet ${a.who || 'the world'}`,
      async run(args, api) { const n = (api.store.get('count', 0) || 0) + 1; api.store.set('count', n); return `Hello, ${args.who || 'world'}! Counter is now ${n}.`; },
    },
    { name: 'hello_read', description: 'Read the shared counter.', parameters: { type: 'object', properties: {} }, risk: 'low', async run(_, api) { return { count: api.store.get('count', 0) || 0 }; } },
  ],
  activate(api) { api.log('hello-panel ready'); },
};
