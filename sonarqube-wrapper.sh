#!/usr/bin/env node
const { execSync, spawn } = require("child_process");
const fs = require("fs");

const env = {};
const envFile = "/app/sonarqube-bootstrap.env";
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
}

const SITE = (env.INFISICAL_SITE_URL || "http://infisical.casa").replace(/\/$/, "");
const CLIENT_ID = env.INFISICAL_MACHINE_CLIENT_ID;
const CLIENT_SECRET = env.INFISICAL_MACHINE_CLIENT_SECRET;
const PROJECT_SLUG = env.SONARQUBE_INFISICAL_PROJECT_SLUG;
const INFISICAL_ENV = env.SONARQUBE_INFISICAL_ENV || "dev";
const SECRET_PATH = env.SONARQUBE_SECRET_PATH || "/";

function doRequest(url, opts) {
  opts = opts || {};
  const headers = Object.entries(opts.headers || {}).map(
    function(kv) { return "--header='" + kv[0] + ": " + kv[1] + "'"; }
  ).join(" ");
  const body = opts.body ? "--post-data='" + opts.body.replace(/'/g, "'\\''") + "'" : "";
  const cmd = "wget -qO- " + headers + " " + body + " '" + url + "'";
  return JSON.parse(execSync(cmd, { encoding: "utf8", timeout: 10000 }));
}

const loginResp = doRequest(SITE + "/api/v1/auth/universal-auth/login", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
});
const accessToken = loginResp.accessToken;

function fetchSecret(name) {
  const qs = "workspaceSlug=" + PROJECT_SLUG + "&environment=" + INFISICAL_ENV +
              "&secretPath=" + encodeURIComponent(SECRET_PATH) + "&type=shared&viewSecretValue=true";
  const r = doRequest(SITE + "/api/v3/secrets/raw/" + name + "?" + qs, {
    headers: { "Authorization": "Bearer " + accessToken }
  });
  return r.secret.secretValue;
}

const SONARQUBE_URL = fetchSecret("SONARQUBE_URL");
const SONARQUBE_TOKEN = fetchSecret("SONARQUBE_TOKEN");

const proc = spawn("docker", [
  "run", "-i", "--rm", "--network", "host",
  "-v", "sonarqube-mcp-storage:/root/.sonarlint",
  "-e", "SONARQUBE_TOKEN=" + SONARQUBE_TOKEN,
  "-e", "SONARQUBE_URL=" + SONARQUBE_URL,
  "mcp/sonarqube"
], { stdio: "inherit", env: process.env });

proc.on("exit", function(code) { process.exit(code != null ? code : 0); });
