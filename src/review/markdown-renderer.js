export function renderReviewMarkdown(result) {
  const lines = [
    `# ${escapeMarkdown(result.service)} review`,
    "",
    `**Order:** \`${escapeInline(result.order_id)}\`  `,
    `**Verdict:** \`${escapeInline(result.verdict)}\`  `,
    `**Score:** ${result.score === null || result.score === undefined ? "not scored" : `${result.score}/100`}  `,
    `**Completed:** ${escapeInline(result.completed_at || "unknown")}`,
    "",
    "## Goal",
    "",
    result.goal || "No goal was supplied.",
    "",
    "## Summary",
    "",
    result.summary,
    "",
    "## Checks",
    "",
  ];

  for (const check of result.checks || []) {
    lines.push(`- **${escapeInline(check.id)}** — \`${escapeInline(check.status)}\`: ${check.summary}`);
  }

  lines.push("", "## Findings", "");
  if (!result.findings?.length) {
    lines.push("No findings were recorded.", "");
  } else {
    for (const finding of result.findings) {
      lines.push(
        `### ${escapeInline(finding.id)} — ${escapeMarkdown(finding.title)}`,
        "",
        `**Severity:** \`${escapeInline(finding.severity)}\``,
        "",
        `**Impact:** ${finding.impact}`,
        "",
        `**Recommendation:** ${finding.recommendation}`,
        "",
        `**Evidence:** ${formatEvidence(finding.evidence)}`,
        "",
      );
    }
  }

  appendList(lines, "Next steps", result.next_steps);
  appendList(lines, "Limitations", result.limitations);

  lines.push(
    "## Target snapshot",
    "",
    "```json",
    JSON.stringify(result.target_snapshot || {}, null, 2),
    "```",
    "",
    "_This report was generated automatically. Verify high-impact changes before production use._",
    "",
  );
  return lines.join("\n");
}

function appendList(lines, heading, values) {
  lines.push(`## ${heading}`, "");
  if (!values?.length) {
    lines.push("None recorded.", "");
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
  lines.push("");
}

function formatEvidence(evidence) {
  const parts = [];
  if (evidence.file) parts.push(`file \`${escapeInline(evidence.file)}\``);
  if (evidence.line !== undefined && evidence.line !== null) parts.push(`line ${Number(evidence.line)}`);
  if (evidence.url) parts.push(`[URL](${escapeUrl(evidence.url)})`);
  if (evidence.observation) parts.push(evidence.observation);
  return parts.join(", ") || "recorded observation";
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function escapeInline(value) {
  return String(value ?? "").replace(/[`\\]/g, "\\$&");
}

function escapeUrl(value) {
  return String(value ?? "").replace(/["'()<>\s]/g, "");
}
