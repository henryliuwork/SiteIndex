import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { readFeeds } from "../src/crawl/gmc-feed";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

it.each([301, 302])("follows HTTP %i to a gzip Feed without Content-Encoding", async (status) => {
  const xml = `<rss><channel><item><id>DEMO-REDIRECT</id><link>https://shop.example.test/p/demo</link>
    <price>10 USD</price></item></channel></rss>`;
  const requested: string[] = [];
  server = createServer((request, response) => {
    requested.push(request.url ?? "");
    if (request.url === "/feed.xml") {
      response.writeHead(status, { location: "/actual.xml.gz" });
      response.end();
      return;
    }
    if (request.url === "/actual.xml.gz") {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(gzipSync(xml));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic loopback server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const rows = await readFeeds({ base_url: base, crawl: { feed_url: `${base}/feed.xml` } });
  expect(requested).toEqual(["/feed.xml", "/actual.xml.gz"]);
  expect(rows.map((row) => row.id)).toEqual(["DEMO-REDIRECT"]);
});
