import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const workDir = process.argv[2];
if (!workDir) throw new Error("Usage: node loopback-server.mjs <work-dir>");
const routes = JSON.parse(fs.readFileSync(path.join(fixtureDir, "routes.json"), "utf8"));
const modeFile = path.join(workDir, "mode.txt");
if (!fs.existsSync(modeFile)) fs.writeFileSync(modeFile, "store_api");
let total = 0;
const byPath = {};

const server = http.createServer((request, response) => {
  if (request.method !== "GET" || !/^127\.0\.0\.1:\d+$/u.test(request.headers.host ?? "")) {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host}`);
  const exact = url.pathname + url.search;
  const mode = fs.readFileSync(modeFile, "utf8").trim();
  let matches = routes.filter((route) => route.method === "GET" && route.path.split("?")[0] === url.pathname);
  if (url.pathname === "/wp-json/wc/store/v1/products") {
    matches = matches.filter((route) => route.scenario === (mode === "api_forbidden" || mode === "api_missing" ? mode : "store_api"));
    if (mode === "store_api" && url.searchParams.get("type") === "variation") {
      matches = matches.filter((route) => route.path.includes("type=variation"));
    } else if (mode === "store_api") {
      matches = matches.filter((route) => !route.path.includes("type=variation"));
    }
  }
  const route = matches.find((item) => item.path === exact) ?? matches[0];
  total++;
  byPath[url.pathname] = (byPath[url.pathname] ?? 0) + 1;
  fs.writeFileSync(path.join(workDir, "requests.json"), JSON.stringify({ total, byPath }));
  if (!route) {
    response.writeHead(404, { "content-type": "text/plain" }).end("fixture route absent");
    return;
  }
  const body = fs.readFileSync(path.join(fixtureDir, route.body), "utf8")
    .replaceAll("https://shop.example.test", `http://127.0.0.1:${server.address().port}`);
  response.writeHead(route.status, { "content-type": `${route.content_type}; charset=utf-8` }).end(body);
});

const requestedPort = fs.existsSync(path.join(workDir, "port.txt"))
  ? Number(fs.readFileSync(path.join(workDir, "port.txt"), "utf8")) : 0;
server.listen(requestedPort, "127.0.0.1", () => {
  fs.writeFileSync(path.join(workDir, "port.txt"), String(server.address().port));
});
