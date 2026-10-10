/**
 * Regenerate the pinned NIST SP 800-53 Rev. 5 Moderate control and SP 800-53A
 * objective list the evidence catalog is checked against.
 *
 *   curl -sSL -o .tmp/oscal/moderate.json \
 *     https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline-resolved-profile_catalog-min.json
 *   pnpm --filter @workspace/scripts run evidence:nist-ids -- .tmp/oscal/moderate.json
 *
 * Writes artifacts/api-server/src/lib/evidence/nist-800-53r5-moderate.json:
 * every control in the resolved Moderate baseline with its label (AC-2,
 * AU-9(4)), title and the SP 800-53A objective labels exactly as NIST prints
 * them (AC-02a.[01], AU-09(04)). Labels come from the OSCAL `label` property
 * with class `sp800-53a`; nothing is reformatted here.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface OscalProp {
  name: string;
  value: string;
  class?: string;
}
interface OscalPart {
  id?: string;
  name: string;
  props?: OscalProp[];
  parts?: OscalPart[];
}
interface OscalControl {
  id: string;
  title: string;
  props?: OscalProp[];
  parts?: OscalPart[];
  controls?: OscalControl[];
}

const SOURCE_URL =
  "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline-resolved-profile_catalog-min.json";

const input = process.argv.slice(2).find((arg) => arg !== "--");
if (!input) {
  console.error("usage: evidence-nist-ids <path to the Moderate resolved-profile catalog JSON>");
  process.exit(2);
}

const raw = readFileSync(input);
const catalog = JSON.parse(raw.toString("utf8")).catalog as {
  metadata: { title: string; version: string; "last-modified": string };
  groups: Array<{ controls?: OscalControl[] }>;
};

function controlLabel(control: OscalControl): string {
  const label =
    control.props?.find((p) => p.name === "label" && !p.class)?.value ??
    control.props?.find((p) => p.name === "label")?.value;
  if (!label) throw new Error(`control ${control.id} has no label`);
  return label;
}

function objectiveLabels(parts: OscalPart[] | undefined, out: string[]): void {
  for (const part of parts ?? []) {
    if (part.name === "assessment-objective") {
      const label = part.props?.find(
        (p) => p.name === "label" && p.class === "sp800-53a"
      )?.value;
      if (label) out.push(label);
    }
    objectiveLabels(part.parts, out);
  }
}

const controls: Record<string, { title: string; objectives: string[] }> = {};
function walk(list: OscalControl[] | undefined): void {
  for (const control of list ?? []) {
    const objectives: string[] = [];
    objectiveLabels(control.parts, objectives);
    controls[controlLabel(control)] = { title: control.title, objectives };
    walk(control.controls);
  }
}
for (const group of catalog.groups) walk(group.controls);

const output = {
  source: SOURCE_URL,
  sha256: createHash("sha256").update(raw).digest("hex"),
  title: catalog.metadata.title,
  version: catalog.metadata.version,
  lastModified: catalog.metadata["last-modified"],
  controls
};

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../artifacts/api-server/src/lib/evidence/nist-800-53r5-moderate.json"
);
writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`);
const objectiveCount = Object.values(controls).reduce((n, c) => n + c.objectives.length, 0);
console.log(
  `[evidence-nist-ids] ${Object.keys(controls).length} controls, ${objectiveCount} objectives -> ${path.relative(process.cwd(), target)}`
);
