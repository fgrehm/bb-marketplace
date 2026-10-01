import { describe, expect, it } from "vitest";
import { inspectRasterAsset } from "./review-assets";

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  Buffer.from("IHDR").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

describe("revision raster assets", () => {
  it("accepts bounded raster signatures and hashes the exact bytes", () => {
    const encoded = png(640, 480);
    expect(
      inspectRasterAsset("screen.png", encoded, "image/png"),
    ).toMatchObject({
      mimeType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 24,
      contentBase64: encoded,
    });
  });

  it("rejects active, corrupt, mismatched, unknown-dimension, and oversized content", () => {
    expect(
      inspectRasterAsset(
        "active.svg",
        Buffer.from("<svg/>").toString("base64"),
      ),
    ).toBeNull();
    expect(
      inspectRasterAsset(
        "broken.png",
        Buffer.from("not png").toString("base64"),
      ),
    ).toBeNull();
    expect(
      inspectRasterAsset("screen.png", png(1, 1), "image/jpeg"),
    ).toBeNull();
    expect(inspectRasterAsset("too-wide.png", png(8193, 1))).toBeNull();
    expect(
      inspectRasterAsset(
        "large.png",
        Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      ),
    ).toBeNull();
    expect(
      inspectRasterAsset(
        "no-dimensions.webp",
        Buffer.from("RIFF0000WEBP").toString("base64"),
      ),
    ).toBeNull();
  });
});
