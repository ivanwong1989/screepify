const http = require("http");
const {
  config,
  assertDevLike,
  buildModulesFromSrc,
} = require("./shared");

assertDevLike();

const modules = buildModulesFromSrc();

const payload = JSON.stringify({
  branch: "default",
  modules,
});

const email = process.env.SCREEPS_EMAIL || config.email;
const password = process.env.SCREEPS_PASSWORD || config.password;

if (!email || !password) {
  throw new Error("Missing local server email/password.");
}

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 21025,
    path: "/api/user/code",
    method: "POST",
    auth: `${email}:${password}`,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      console.log(`HTTP ${res.statusCode}`);
      console.log(body);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        process.exitCode = 1;
      }
    });
  }
);

req.on("error", (err) => {
  console.error("Local deploy failed:", err);
  process.exit(1);
});

req.write(payload);
req.end();