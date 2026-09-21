import http from "node:http";
import https from "node:https";
import net from "node:net";

const listenHost = "0.0.0.0";
const listenPort = positiveInteger(process.env.PHASE50_PROXY_PORT ?? "3128", "PHASE50_PROXY_PORT");
const allowedOrigins = parseAllowedOrigins(process.env.PHASE50_PROXY_ALLOWED_ORIGINS);

const server = http.createServer((request, response) => {
  let target;
  try {
    target = new URL(request.url ?? "");
  } catch {
    rejectHttp(response, 400, "invalid absolute proxy URL");
    return;
  }

  if (!isAllowedOrigin(target)) {
    rejectHttp(response, 403, "destination is not allowlisted");
    return;
  }

  const client = target.protocol === "https:" ? https : http;
  const upstream = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === "" ? undefined : Number(target.port),
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: sanitizedHeaders(request.headers, target.host),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(10_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => rejectHttp(response, 502, "upstream request failed"));
  request.pipe(upstream);
});

server.on("connect", (request, clientSocket, head) => {
  const authority = request.url ?? "";
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) {
    rejectConnect(clientSocket, 400, "invalid CONNECT authority");
    return;
  }
  const hostname = authority.slice(0, separator);
  const portText = authority.slice(separator + 1);
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    rejectConnect(clientSocket, 400, "invalid CONNECT port");
    return;
  }

  const origin = normalizeOrigin(`https://${hostname}:${port}`);
  if (!allowedOrigins.has(origin)) {
    rejectConnect(clientSocket, 403, "destination is not allowlisted");
    return;
  }

  const upstream = net.connect({ host: hostname, port }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!clientSocket.destroyed) {
      rejectConnect(clientSocket, 502, "upstream connection failed");
    }
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`phase50 allowlist proxy listening on ${listenHost}:${listenPort}\n`);
});

function parseAllowedOrigins(raw) {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("PHASE50_PROXY_ALLOWED_ORIGINS is required");
  }
  const values = raw.split(",").map((entry) => normalizeOrigin(entry.trim()));
  if (values.some((entry) => entry === "")) {
    throw new Error("PHASE50_PROXY_ALLOWED_ORIGINS contains an empty entry");
  }
  return new Set(values);
}

function normalizeOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported proxy origin protocol: ${parsed.protocol}`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`proxy allowlist entry must be a credential-free origin: ${value}`);
  }
  const port = parsed.port === ""
    ? parsed.protocol === "https:" ? "443" : "80"
    : parsed.port;
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

function isAllowedOrigin(target) {
  return allowedOrigins.has(normalizeOrigin(target.origin));
}

function sanitizedHeaders(headers, host) {
  const output = { ...headers, host };
  delete output["proxy-authorization"];
  delete output["proxy-connection"];
  return output;
}

function rejectHttp(response, status, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function rejectConnect(socket, status, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\n\r\n${message}\n`);
  }
}

function positiveInteger(raw, name) {
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}
