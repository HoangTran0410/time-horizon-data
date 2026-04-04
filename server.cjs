/**
 * Simple static file server with CORS headers.
 * Serves files relative to its own directory.
 *
 * Usage:
 *   node server.cjs           # default port 5500
 *   node server.cjs 8080      # custom port
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.argv[2] ?? "5500", 10);
const BASE_DIR = __dirname;

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const MIME_TYPES = {
    ".html": "text/html",
    ".css":  "text/css",
    ".js":   "application/javascript",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".webp": "image/webp",
  };
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(err.code === "ENOENT" ? "Not Found" : "Internal Server Error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // Strip leading "/data" prefix so requests like /data/collections/cosmic.json
  // map to the local collections/cosmic.json
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath.startsWith("/data")) {
    urlPath = urlPath.slice("/data".length) || "/";
  }

  const safePath = path.normalize(path.join(BASE_DIR, urlPath));
  if (!safePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats) {
      serveFile(res, path.join(BASE_DIR, "index.html"));
      return;
    }
    if (stats.isDirectory()) {
      // Try index.html in dir, else serve directory listing
      const indexPath = path.join(safePath, "index.html");
      fs.stat(indexPath, (iErr, iStats) => {
        if (!iErr && iStats.isFile()) {
          serveFile(res, indexPath);
        } else {
          // Directory listing
          fs.readdir(safePath, (_readErr, files) => {
            res.writeHead(200, {
              "Content-Type": "text/html",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(`<html><body><h1>${urlPath}</h1><ul>${files
              .map((f) => `<li><a href="${urlPath}/${f}">${f}</a></li>`)
              .join("")}</ul></body></html>`);
          });
        }
      });
    } else {
      serveFile(res, safePath);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[time-horizon-data] Server running at http://localhost:${PORT}/data`);
  console.log(`[time-horizon-data] Serving: ${BASE_DIR}`);
  console.log(`[time-horizon-data] Press Ctrl+C to stop`);
});
