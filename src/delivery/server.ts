import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";

const FILES: Record<string, { name: string; contentType: string }> = {
  "/daily/latest.epub": { name: "latest.epub", contentType: "application/epub+zip" },
  "/daily/latest.json": { name: "latest.json", contentType: "application/json; charset=utf-8" }
};

export function startDeliveryServer(config: AppConfig): void {
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    const target = request.url ? FILES[request.url] : undefined;
    if (!target) {
      response.writeHead(404).end("Not found");
      return;
    }

    const filePath = path.join(config.outputDir, target.name);
    if (!fs.existsSync(filePath)) {
      response.writeHead(404).end("Edition not generated yet");
      return;
    }

    response.writeHead(200, {
      "content-type": target.contentType,
      "cache-control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(response);
  });

  server.listen(config.port, config.host, () => {
    console.log(`Delivery server listening on http://${config.host}:${config.port}`);
  });
}
