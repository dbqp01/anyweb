import { createServer } from 'node:http';

export const products = [
  { id: 'p1', name: 'Laptop Pro', price: 1200, description: 'Pro laptop' },
  { id: 'p2', name: 'Laptop Air', price: 900, description: 'Air laptop' },
  { id: 'p3', name: 'Phone Max', price: 800, description: 'Max phone' },
];

const authorized = request => (request.headers.cookie ?? '').split(';').some(part => part.trim() === 'sid=letmein');

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export async function startFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), at: Date.now() });
    if (request.method === 'GET' && url.pathname === '/browser') {
      const catalog = [...products, { id: 'p4', name: 'Tablet Mini', price: 350, description: 'Compact tablet' }];
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(`<!doctype html><html><head><title>Browser-only catalogue</title></head><body>
<label>Product <input id="browser-query"></label><button onclick="search()">Search</button>
<div id="browser-results"></div><article id="browser-detail"></article>
<script>
const products = ${JSON.stringify(catalog)};
function search() {
  const query = document.querySelector('#browser-query').value.toLowerCase();
  document.querySelector('#browser-results').replaceChildren();
  for (const product of products.filter(product => product.name.toLowerCase().includes(query))) {
    const button = document.createElement('button'); button.textContent = product.name;
    button.onclick = () => setTimeout(() => {
      const detail = document.querySelector('#browser-detail'); detail.dataset.id = product.id;
      detail.innerHTML = '<h1>' + product.name + '</h1><span class="price">' + product.price + '</span>';
    }, 40);
    document.querySelector('#browser-results').append(button);
  }
}
</script></body></html>`);
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(`<!doctype html><html><head><title>Fixture shop</title></head><body>
<main><h1>Fixture shop</h1>
<label>Search <input aria-label="Search products" id="q"></label>
<button onclick="search()">Search</button>
<ul id="results"></ul>
<button onclick="fetch('/api/item', { method: 'DELETE' })">Delete item</button>
<a href="/about">About</a></main>
<script>
async function search() {
  const q = document.querySelector('#q').value;
  const response = await fetch('/api/products?q=' + encodeURIComponent(q));
  const data = await response.json();
  document.querySelector('#results').innerHTML = data.products.map(product => '<li><a href="/product?id=' + product.id + '">' + product.name + '</a></li>').join('');
}
</script></body></html>`);
    }
    if (request.method === 'GET' && url.pathname === '/about') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end('<!doctype html><html><head><title>About</title></head><body><h1>About the fixture</h1><a href="/">Home</a></body></html>');
    }
    if (request.method === 'GET' && url.pathname === '/html/search') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const matches = products.filter(product => product.name.toLowerCase().includes(query));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(`<!doctype html><html><head><title>Search: ${query}</title></head><body>
<ul>${matches.map(product => `<li class="result" data-id="${product.id}"><a href="/product?id=${product.id}"><span class="name">${product.name}</span></a><span class="price">${product.price}</span></li>`).join('')}</ul>
</body></html>`);
    }
    if (request.method === 'GET' && url.pathname === '/product') {
      const product = products.find(item => item.id === url.searchParams.get('id'));
      if (!product) { response.writeHead(404, { 'content-type': 'text/html' }); return response.end('<h1>Not found</h1>'); }
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(`<!doctype html><html><head><title>${product.name}</title></head><body><h1>${product.name}</h1><p>Price: ${product.price}</p><p id="detail">${product.description}</p><a href="/">Home</a>
<script>fetch('/api/product?id=${product.id}').then(response => response.json()).then(product => { document.querySelector('#detail').textContent = product.description; });</script></body></html>`);
    }
    if (request.method === 'GET' && url.pathname === '/private') {
      response.writeHead(authorized(request) ? 200 : 401, { 'content-type': 'text/html' });
      return response.end(authorized(request)
        ? '<!doctype html><html><head><title>Private</title></head><body><h1>Private area</h1></body></html>'
        : '<!doctype html><html><head><title>Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>');
    }
    if (request.method === 'GET' && url.pathname === '/api/private/products') {
      return authorized(request) ? json(response, 200, { products }) : json(response, 401, { error: 'unauthorized' });
    }
    if (request.method === 'GET' && url.pathname === '/api/private/product') {
      if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
      const product = products.find(item => item.id === url.searchParams.get('id'));
      return product ? json(response, 200, product) : json(response, 404, { error: 'not found' });
    }
    if (request.method === 'GET' && url.pathname === '/api/products') {
      return json(response, 200, { query: url.searchParams.get('q') ?? '', products });
    }
    if (request.method === 'GET' && url.pathname === '/api/search') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      return json(response, 200, { query, products: products.filter(product => product.name.toLowerCase().includes(query)) });
    }
    if (request.method === 'GET' && url.pathname === '/api/product') {
      const product = products.find(item => item.id === url.searchParams.get('id'));
      return product ? json(response, 200, product) : json(response, 404, { error: 'not found' });
    }
    if (request.method === 'GET' && url.pathname === '/api/file') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      return response.end(`PDF:${url.searchParams.get('name')}`);
    }
    if (request.method === 'POST' && url.pathname === '/api/echo') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => json(response, 200, { echo: JSON.parse(Buffer.concat(chunks).toString('utf8')), user_agent: request.headers['user-agent'] }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/item') return json(response, 200, { deleted: true });
    json(response, 404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
