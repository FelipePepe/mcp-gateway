#!/usr/bin/env node
const { spawn } = require("child_process");
const fs = require("fs");

const env = {};
const envFile = "/app/sonarqube-bootstrap.env";
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
}

const SONARQUBE_URL = env.SONARQUBE_URL;
const SONARQUBE_TOKEN = env.SONARQUBE_TOKEN;

if (!SONARQUBE_URL || !SONARQUBE_TOKEN) {
  process.stderr.write("ERROR: SONARQUBE_URL or SONARQUBE_TOKEN not set in sonarqube-bootstrap.env\n");
  process.exit(1);
}

const proc = spawn("docker", [
  "run", "-i", "--rm", "--network", "host",
  "-v", "sonarqube-mcp-storage:/root/.sonarlint",
  "-e", "SONARQUBE_TOKEN=" + SONARQUBE_TOKEN,
  "-e", "SONARQUBE_URL=" + SONARQUBE_URL,
  "mcp/sonarqube"
], { stdio: "inherit", env: process.env });

proc.on("exit", function(code) { process.exit(code != null ? code : 0); });
