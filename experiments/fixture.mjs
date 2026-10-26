import { startFixture, products } from '../test/fixtures/server.mjs';
import { createServer } from 'node:http';

// Synthetic evaluation records are absent from the two training searches' chosen details.
products.push(
  { id: 'p4', name: 'Tablet Mini', price: 450, description: 'Small tablet' },
  { id: 'p5', name: 'Camera Lite', price: 650, description: 'Travel camera' },
);
const fixture = await startFixture();
const server = createServer(async (req, res) => {
  try {
    const response = await fetch(new URL(req.url, fixture.origin));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(502); res.end(); }
});
server.listen(4331, '127.0.0.1', () => console.log('Experiment fixture: http://127.0.0.1:4331'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => fixture.close().then(() => process.exit(0))));
