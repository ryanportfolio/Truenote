import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadForm } from "../UploadForm";

describe("UploadForm original source location", () => {
  it("keeps the optional location field off by default", () => {
    const html = renderToStaticMarkup(<UploadForm sources={[]} />);

    expect(html).toContain("Add original source location");
    expect(html).not.toContain('name="sourceOriginUri"');
  });

  it("accepts multiple documents in one selection", () => {
    const html = renderToStaticMarkup(<UploadForm sources={[]} />);

    expect(html).toContain('name="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain("Select or drop up to 20 documents");
  });
});
