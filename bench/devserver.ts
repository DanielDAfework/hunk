/**
 * Benchmark fixture: a dev-server-shaped process. Prints startup chatter,
 * binds a port, announces it, then logs forever — it never exits, like every
 * real dev server an agent has ever had to babysit.
 */
const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
console.log("dev-server v0.1.0");
console.log("loading config from ./devserver.config.ts");
console.log("compiling 214 modules...");
console.log(`Listening on http://localhost:${server.port}`);

const routes = ["/", "/api/items", "/api/user", "/health", "/assets/app.js"];
let i = 0;
setInterval(() => {
  i += 1;
  const route = routes[i % routes.length];
  console.log(`GET ${route} 200 ${(Math.sin(i) * 3 + 5).toFixed(1)}ms`);
}, 150);
