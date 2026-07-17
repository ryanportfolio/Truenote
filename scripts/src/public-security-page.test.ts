import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
        "which safeguards are in place, how we tested them, and what still needs independent review"
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
    assert.ok(
      pciReadiness.includes("Not a compliance or certification claim")
    );
    assert.ok(pciReadiness.includes("<h1>Truenote PCI security readiness</h1>"));
    assert.ok(
      pciReadiness.includes(
        "what still needs operational proof or independent review before a PCI assessment"
      )
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
