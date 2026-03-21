const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const config = require("../.screeps.json");

function getCurrentBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  } catch (e) {
    return "unknown";
  }
}

function assertMasterLike() {
  const currentBranch = getCurrentBranch();
  if (currentBranch !== "master" && !currentBranch.startsWith("dev")) {
    throw new Error(
      `Safety Check: You are on "${currentBranch}". You must be on "master" or a dev branch to push.`
    );
  }
  console.log(`Branch verified: ${currentBranch}`);
}

function assertDevLike() {
  const currentBranch = getCurrentBranch();
  if (currentBranch !== "master" && !currentBranch.startsWith("dev")) {
    throw new Error(
      `Safety Check: You are on "${currentBranch}". You must be on "dev" or "master" to push to private/local.`
    );
  }
  console.log(`Branch verified: ${currentBranch}`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function buildModulesFromSrc(srcDir = path.resolve(__dirname, "../src")) {
  const files = walkFiles(srcDir);
  const modules = {};

  for (const fullPath of files) {
    const rel = path.relative(srcDir, fullPath).replace(/\\/g, "/");
    const moduleName = rel.replace(/\.js$/i, "").replace(/\//g, "_");
    const content = fs.readFileSync(fullPath, "utf8");
    modules[moduleName] = content;
  }

  return modules;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clearJsFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && full.endsWith(".js")) {
      fs.unlinkSync(full);
    }
  }
}

module.exports = {
  config,
  getCurrentBranch,
  assertMasterLike,
  assertDevLike,
  buildModulesFromSrc,
  ensureDir,
  clearJsFiles,
};