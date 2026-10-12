// Renders the REMOTION_MCP_AUDIT_LOG events as standalone HTML. Args: [--out gateway.html]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents } from "../dist/services/audit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "dashboard", "template.html");

function outPath() {
  const i = process.argv.indexOf("--out");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : path.resolve("gateway.html");
}

const events = readAuditEvents();
const securityEvents = events.filter(
  (e) => e.event === "tool_rejected" || e.event === "tool_failed" || e.event === "network_block",
);
const byTool = {};
const byCategory = {};
for (const e of events) {
  if (e.tool) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  if (e.category) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
}

const data = {
  generatedAt: new Date().toISOString(),
  total: events.length,
  events,
  securityEvents,
  byTool,
  byCategory,
};

const template = fs.readFileSync(templatePath, "utf8");
// Escape "<" so a string value cannot close the embedding <script> block.
const json = JSON.stringify(data).replace(/</g, "\\u003c");
// Function replacer so $-patterns in the JSON are inserted literally.
const html = template.replace("__AUDIT_DATA__", () => json);

const out = outPath();
fs.writeFileSync(out, html, "utf8");
console.error(`Wrote ${out} — ${events.length} events, ${securityEvents.length} security events.`);
