import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../config.js";
import { logger } from "../logging.js";
import { buildDeliveryHealth } from "../operations/status.js";

const FILES: Record<string, { name: string; contentType: string }> = {
  "/daily/latest.epub": { name: "latest.epub", contentType: "application/epub+zip" },
  "/daily/latest.json": { name: "latest.json", contentType: "application/json; charset=utf-8" }
};

export interface DeliveryServerHandle {
  server: http.Server;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

function sendText(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function requestPath(request: http.IncomingMessage): string | undefined {
  if (!request.url) return undefined;
  try {
    return new URL(request.url, "http://delivery.local").pathname;
  } catch {
    return undefined;
  }
}

export function createDeliveryServer(config: AppConfig): http.Server {
  const log = logger.child({ component: "delivery-server" });
  const server = http.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        sendText(response, 405, "Method not allowed");
        return;
      }

      const pathname = requestPath(request);
      if (pathname === "/healthz") {
        const health = await buildDeliveryHealth(config);
        const body = `${JSON.stringify(health)}\n`;
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store"
        });
        response.end(method === "HEAD" ? undefined : body);
        return;
      }

      const target = pathname ? FILES[pathname] : undefined;
      if (!target) {
        sendText(response, 404, "Not found");
        return;
      }

      const filePath = path.join(config.outputDir, target.name);
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          sendText(response, 404, "Edition not generated yet");
          return;
        }
        throw error;
      }
      if (!stat.isFile()) {
        sendText(response, 404, "Edition not generated yet");
        return;
      }

      response.writeHead(200, {
        "content-type": target.contentType,
        "content-length": stat.size,
        "cache-control": "no-cache"
      });
      if (method === "HEAD") {
        response.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      stream.on("error", (error) => {
        log.error("failed while streaming delivery file", { route: pathname, error });
        response.destroy(error instanceof Error ? error : undefined);
      });
      stream.pipe(response);
    })().catch((error) => {
      log.error("delivery request failed", { route: requestPath(request), error });
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        const body = '{"ok":false,"server":"error"}\n';
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store"
        });
        response.end(body);
      }
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on("error", (error) => {
    log.error("delivery server error", { error });
  });
  return server;
}

export async function startDeliveryServer(config: AppConfig): Promise<DeliveryServerHandle> {
  const log = logger.child({ component: "delivery-server" });
  const server = createDeliveryServer(config);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  log.info("delivery server listening", {
    host: typeof address === "object" && address ? address.address : config.host,
    port: typeof address === "object" && address ? address.port : config.port
  });

  return {
    server,
    address: () => server.address(),
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
