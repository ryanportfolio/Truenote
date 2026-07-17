import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const securityPolicy = readFileSync(
  new URL("../../SECURITY.md", import.meta.url),
  "utf8"
);
const securityTxt = readFileSync(
  new URL("../../artifacts/rag-app/public/.well-known/security.txt", import.meta.url),
  "utf8"
);
const sitemap = readFileSync(
  new URL("../../artifacts/rag-app/public/sitemap.xml", import.meta.url),
  "utf8"
);
const loginSource = readFileSync(
  new URL("../../artifacts/rag-app/src/pages/Login.tsx", import.meta.url),
  "utf8"
);
const securityOverview = readFileSync(
  new URL("../../docs/security/truenote-security-capabilities.html", import.meta.url),
  "utf8"
);
const pciReadiness = readFileSync(
  new URL("../../docs/security/truenote-pci-security-capabilities.html", import.meta.url),
  "utf8"
);
const internalPciLedger = readFileSync(
  new URL(
    "../../docs/compliance/pci/security-readiness-session-report-2026-07-16.html",
    import.meta.url
  ),
  "utf8"
);
const viteConfig = readFileSync(
  new URL("../../artifacts/rag-app/vite.config.ts", import.meta.url),
  "utf8"
);
const apiApp = readFileSync(
  new URL("../../artifacts/api-server/src/app.ts", import.meta.url),
  "utf8"
);
const normalizedSecurityPolicy = securityPolicy.replace(/\s+/g, " ");

describe("public security reporting surface", () => {
  it("publishes a discoverable private reporting path without inventing email or SLA claims", () => {
    assert.ok(securityPolicy.includes("Report a vulnerability"));
    assert.ok(securityPolicy.includes("Do not open a public issue with exploit details"));
    assert.equal(securityPolicy.includes("mailto:"), false);
    assert.ok(loginSource.includes('href="/security/"'));
    assert.ok(securityOverview.includes('href="/security/pci/"'));
    assert.ok(
      securityOverview.includes(
        "This page includes only safeguards that have completed repository evidence"
      )
    );
    assert.equal(securityOverview.includes("living PCI DSS readiness record"), false);
    assert.equal(securityOverview.includes("completed Requirement 6 work"), false);
    assert.equal(securityOverview.includes("external-evidence gates"), false);
    assert.equal(securityOverview.includes('href="/security/report/"'), false);
    assert.ok(sitemap.includes("<loc>https://truenote.org/security/</loc>"));
    assert.ok(sitemap.includes("<loc>https://truenote.org/security/pci/</loc>"));
    assert.equal(
      sitemap.includes("<loc>https://truenote.org/security/report/</loc>"),
      false
    );
    assert.ok(
      pciReadiness.includes(
        '<link rel="canonical" href="https://truenote.org/security/pci/">'
      )
    );
    assert.ok(pciReadiness.includes("<h1>PCI-focused safeguards in Truenote</h1>"));
    assert.ok(
      pciReadiness.includes(
        "PCI DSS includes secure-software requirements"
      )
    );
    assert.ok(pciReadiness.includes("<h2>Completed safeguards</h2>"));
    assert.ok(pciReadiness.includes("<h2>Checks that passed</h2>"));
    assert.ok(pciReadiness.includes("<h2>Open the complete public evidence set</h2>"));
    assert.equal(pciReadiness.includes("Evidence boundary:"), false);
    assert.equal(
      pciReadiness.includes(
        "It is not a claim that Truenote is PCI DSS compliant, certified, or independently assessed"
      ),
      false
    );
    assert.equal(
      (pciReadiness.match(/class="evidence-link"/g) ?? []).length,
      31
    );
    assert.equal(
      (pciReadiness.match(/target="_blank" rel="noreferrer"/g) ?? []).length,
      31
    );
    const evidenceHrefs = [
      ...pciReadiness.matchAll(/class="evidence-link" href="([^"]+)"/g)
    ].map((match) => match[1] ?? "");
    assert.equal(new Set(evidenceHrefs).size, 31);
    for (const href of evidenceHrefs) {
      const repositoryPath = href.split("/blob/main/")[1];
      if (repositoryPath) {
        assert.ok(
          existsSync(new URL(`../../${repositoryPath}`, import.meta.url)),
          `public evidence target does not exist: ${repositoryPath}`
        );
      }
    }
    for (const evidencePath of [
      "secure-development-lifecycle.md",
      "threat-model.md",
      "secure-development-training-curriculum.md",
      "change-control.md",
      "manual-change-record-template.md",
      "evidence-index.md",
      "provider-input-firewall.md",
      "provider-input-firewall.ts",
      "provider-input-firewall.test.ts",
      "ask-sensitive-input-handling.md",
      "ask-content-policy.ts",
      "ask-content-policy.test.ts",
      "model-output-sensitive-data-handling.md",
      "generation/answer.ts",
      "generation/__tests__/answer.test.ts",
      "retrieval/query.ts",
      "retrieval/__tests__/program-scope.test.ts",
      "security/__tests__/negative-controls.test.ts",
      "security/content-scan.ts",
      "security/__tests__/content-scan.test.ts",
      "middleware/browser-security.ts",
      "middleware/__tests__/browser-security.test.ts",
      "security/audit.ts",
      "security/siem-outbox.ts",
      "security/__tests__/siem-outbox.test.ts",
      "p1-siem-delivery-outbox.sql",
      "actions/workflows/security.yml",
      ".github/workflows/security.yml",
      "verify-pci-evidence.ts",
      "verify-pci-evidence.test.ts",
      "public-security-page.test.ts"
    ]) {
      assert.ok(
        pciReadiness.includes(evidencePath),
        `missing public evidence link: ${evidencePath}`
      );
    }
    for (const publicSource of [securityOverview, pciReadiness]) {
      for (const internalOnlyText of [
        "Implemented, unverified",
        "Operational evidence required",
        "Third-party evidence required",
        "Earliest incomplete gate",
        "what still needs",
        "Requirement 6",
        "TN-WORK-",
        "P0 remains open"
      ]) {
        assert.equal(
          publicSource.includes(internalOnlyText),
          false,
          `public page leaked internal status text: ${internalOnlyText}`
        );
      }
    }
    assert.ok(internalPciLedger.includes("Earliest incomplete gate"));
    assert.ok(internalPciLedger.includes("TN-WORK-"));
    assert.ok(
      viteConfig.includes(
        '"../../docs/security/truenote-pci-security-capabilities.html"'
      )
    );
    assert.equal(
      viteConfig.includes("security-readiness-session-report-2026-07-16.html"),
      false
    );
    assert.ok(viteConfig.includes('fileName: "security/pci/index.html"'));
    assert.ok(viteConfig.includes('fileName: "security-pci.html"'));
    assert.ok(viteConfig.includes('fileName: "security/pci/styles.css"'));
    assert.ok(apiApp.includes('"/security/pci/"'));
    assert.ok(apiApp.includes('res.sendFile("security-pci.html"'));
  });

  it("keeps sensitive-data, safe-testing, and assurance boundaries on the public page", () => {
    for (const required of [
      "using synthetic data",
      "payment-card data",
      "Do not access data that is not yours",
      "degrade a shared service",
      "test third-party providers without their permission",
      "Source code and passing CI do not prove",
      "not represented as FedRAMP compliant"
    ]) {
      assert.ok(
        normalizedSecurityPolicy.includes(required),
        `missing public security text: ${required}`
      );
    }
  });

  it("keeps an accessible Security overview and CSP-safe build publisher", () => {
    assert.ok(securityOverview.includes('<main class="shell">'));
    assert.ok(securityOverview.includes('<h1>Security controls Truenote has today</h1>'));
    assert.ok(securityOverview.includes('<nav aria-label="Document sections">'));
    assert.ok(securityOverview.includes("focus-visible"));
    assert.ok(securityOverview.includes("@media (max-width: 590px)"));
    assert.ok(securityOverview.includes("<h2>Verified safeguards</h2>"));
    assert.ok(securityOverview.includes("<h2>Security delivery checks</h2>"));
    assert.ok(viteConfig.includes("loadStandalonePage"));
    assert.ok(viteConfig.includes("<link rel=\"stylesheet\""));
  });

  it("publishes a current RFC 9116 discovery record", () => {
    assert.ok(
      securityTxt.includes(
        "Contact: https://github.com/ryanportfolio/Truenote/security/advisories/new"
      )
    );
    assert.ok(
      securityTxt.includes(
        "Canonical: https://truenote.org/.well-known/security.txt"
      )
    );
    assert.ok(
      securityTxt.includes(
        "Policy: https://github.com/ryanportfolio/Truenote/security/policy"
      )
    );
    const expires = /^Expires:\s*(.+)$/m.exec(securityTxt)?.[1];
    assert.ok(expires, "security.txt must contain Expires");
    const expiresAt = Date.parse(expires);
    assert.equal(Number.isFinite(expiresAt), true);
    assert.ok(expiresAt > Date.now(), "security.txt must not be expired");
    assert.ok(
      expiresAt - Date.now() <= 366 * 24 * 60 * 60 * 1000,
      "security.txt expiry must stay within the next year"
    );
  });
});
