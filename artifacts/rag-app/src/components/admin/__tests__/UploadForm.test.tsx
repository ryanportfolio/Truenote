import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadForm } from "../UploadForm";

describe("UploadForm original source location", () => {
  it("keeps the optional location field off by default", () => {
    const html = renderToStaticMarkup(<UploadForm sources={[]} />);

    expect(html).toContain("Add original source location");
    expect(html).not.toContain('name="sourceOriginUri"');
  });
});
