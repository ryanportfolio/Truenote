import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const securityHtml = readFileSync(
  new URL(
    "../../artifacts/rag-app/public/security/report/index.html",
    import.meta.url
  ),
  "utf8"
);
const securityCss = readFileSync(
  new URL(
    "../../artifacts/rag-app/public/security/report/styles.css",
    import.meta.url
  ),
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
const normalizedSecurityHtml = securityHtml.replace(/\s+/g, " ");

describe("public security reporting surface", () => {
  it("publishes a discoverable private reporting path without inventing email or SLA claims", () => {
    assert.match(
      securityHtml,
      /<link rel="canonical" href="https:\/\/truenote\.org\/security\/report\/"/
    );
    assert.ok(
      securityHtml.includes(
        'href="https://github.com/ryanportfolio/Truenote/security/advisories/new"'
      )
    );
    assert.ok(securityHtml.includes("Open a private GitHub report"));
    assert.ok(securityHtml.includes("Do not open a public issue with exploit details"));
    assert.ok(securityHtml.includes("No response-time or remediation-time SLA is represented here"));
    assert.equal(securityHtml.includes("mailto:"), false);
    assert.ok(loginSource.includes('href="/security/"'));
    assert.ok(securityOverview.includes('href="/security/report/"'));
    assert.ok(sitemap.includes("<loc>https://truenote.org/security/</loc>"));
    assert.ok(sitemap.includes("<loc>https://truenote.org/security/report/</loc>"));
  });

  it("keeps sensitive-data, safe-testing, and assurance boundaries on the public page", () => {
    for (const required of [
      "Use synthetic data",
      "payment-card data",
      "Do not access data that is not yours",
      "Do not degrade a shared service",
      "Do not test model or infrastructure providers without permission",
      "Source code, configuration, and local tests do not prove",
      "not represented here as PCI DSS compliant"
    ]) {
      assert.ok(
        normalizedSecurityHtml.includes(required),
        `missing public security text: ${required}`
      );
    }
  });

  it("uses an external stylesheet and accessible static document structure", () => {
    assert.ok(securityHtml.includes('<a class="skip-link" href="#main-content">'));
    assert.ok(securityHtml.includes('<main id="main-content">'));
    assert.ok(securityHtml.includes('<h1 id="security-title">'));
    assert.ok(securityHtml.includes('rel="noreferrer"'));
    assert.ok(securityHtml.includes('<link rel="stylesheet" href="./styles.css"'));
    assert.equal(securityHtml.includes("<style"), false);
    assert.equal(securityHtml.includes("<script"), false);
    assert.ok(securityCss.includes("focus-visible"));
    assert.ok(securityCss.includes("@media (max-width: 480px)"));
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
      securityTxt.includes("Policy: https://truenote.org/security/report/")
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
