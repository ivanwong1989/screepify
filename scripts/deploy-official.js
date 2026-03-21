const https = require("https");
const { performance } = require("perf_hooks");
const {
  config,
  assertMasterLike,
  buildModulesFromSrc,
} = require("./shared");

assertMasterLike();

const t0 = performance.now();
const mark = (label) => {
  const dt = (performance.now() - t0).toFixed(1);
  console.log(`[${dt} ms] ${label}`);
};

const modules = buildModulesFromSrc();
//const modules = { main: "module.exports.loop = function() {};" };
mark("Modules built");

const payload = JSON.stringify({
  branch: process.env.SCREEPS_BRANCH || config.branch || "default",
  modules,
});

mark(`Payload ready (${Buffer.byteLength(payload)} bytes)`);

const token = process.env.SCREEPS_TOKEN || config.token;
if (!token) {
  throw new Error("Missing Screeps token.");
}

const req = https.request(
  {
    hostname: "screeps.com",
    port: 443,
    path: "/api/user/code",
    method: "POST",
    headers: {
      "X-Token": token,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    },
    family: 4,
  },
  (res) => {
    mark(`Response received: HTTP ${res.statusCode}`);

    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
      mark(`Response data chunk (${chunk.length} bytes)`);
    });

    res.on("end", () => {
      mark("Response end");
      console.log(`HTTP ${res.statusCode}`);
      console.log(body);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        process.exitCode = 1;
      }
    });
  }
);

req.setTimeout(180000, () => {
  mark("Request timeout");
  req.destroy(new Error("Request timed out after 120s"));
});

req.on("socket", (socket) => {
  let progressTimer = null;

  mark("Socket assigned");
  socket.setNoDelay(true);

  socket.on("lookup", (err, address, family, host) => {
    mark(
      `DNS lookup: host=${host} address=${address} family=${family} err=${err ? err.message : "none"}`
    );
  });

  socket.on("connect", () => {
    mark("TCP connect");
  });

  socket.on("secureConnect", () => {
    mark(
      `TLS secureConnect: protocol=${socket.getProtocol()} reusedSession=${socket.isSessionReused()}`
    );

    const cert = socket.getPeerCertificate();
    if (cert && cert.subject) {
      mark(`Peer cert CN=${cert.subject.CN || "unknown"}`);
    }

    progressTimer = setInterval(() => {
      mark(
        `Socket progress: bytesWritten=${socket.bytesWritten} bytesRead=${socket.bytesRead} writableLength=${socket.writableLength}`
      );
    }, 2000);
  });

  socket.on("drain", () => {
    mark(
      `Socket drain: bytesWritten=${socket.bytesWritten} writableLength=${socket.writableLength}`
    );
  });

  socket.on("timeout", () => {
    mark("Socket timeout");
  });

  socket.on("close", (hadError) => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    mark(`Socket close (hadError=${hadError})`);
  });

  socket.on("error", (err) => {
    mark(`Socket error: ${err.message}`);
  });
});

req.on("finish", () => {
  mark("Request stream finished writing");
});

req.on("error", (err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});

mark("Writing request payload");
const ok = req.write(payload);
mark(`req.write returned ${ok}`);
req.end();
mark("req.end() called");