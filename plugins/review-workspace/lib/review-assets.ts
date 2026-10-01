import { createHash } from "node:crypto";

export const IMAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_DIMENSION_MAX = 8192;

export function isRasterImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(path);
}

export type RasterAsset = {
  mimeType:
    "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  contentBase64: string;
};

function u24le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7) return null;
      return [
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
      ];
    }
    offset += length;
  }
  return null;
}

function inspectDimensions(
  bytes: Uint8Array,
  mimeType: RasterAsset["mimeType"],
): [number, number] | null {
  if (mimeType === "image/png" && bytes.length >= 24)
    return [
      (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!,
      (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!,
    ];
  if (mimeType === "image/gif" && bytes.length >= 10)
    return [bytes[6]! | (bytes[7]! << 8), bytes[8]! | (bytes[9]! << 8)];
  if (mimeType === "image/bmp" && bytes.length >= 26)
    return [
      Math.abs(
        bytes[18]! |
          (bytes[19]! << 8) |
          (bytes[20]! << 16) |
          (bytes[21]! << 24) |
          0,
      ),
      Math.abs(
        bytes[22]! |
          (bytes[23]! << 8) |
          (bytes[24]! << 16) |
          (bytes[25]! << 24) |
          0,
      ),
    ];
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1];
  }
  return null;
}

function detectMime(
  path: string,
  bytes: Uint8Array,
): RasterAsset["mimeType"] | null {
  const ext = path.toLowerCase().split(".").pop();
  if (
    ext === "png" &&
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  )
    return "image/png";
  if (ext === "jpg" || ext === "jpeg")
    return bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
      ? "image/jpeg"
      : null;
  if (
    ext === "gif" &&
    String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")
  )
    return "image/gif";
  if (ext === "bmp" && bytes[0] === 0x42 && bytes[1] === 0x4d)
    return "image/bmp";
  if (
    ext === "webp" &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

export function inspectRasterAsset(
  path: string,
  contentBase64: string,
  declaredMimeType?: string,
): RasterAsset | null {
  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length || bytes.length > IMAGE_ASSET_MAX_BYTES) return null;
  const mimeType = detectMime(path, bytes);
  if (!mimeType || (declaredMimeType && declaredMimeType !== mimeType))
    return null;
  const dimensions = inspectDimensions(bytes, mimeType);
  if (!dimensions) return null;
  const [width, height] = dimensions;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > IMAGE_DIMENSION_MAX ||
    height > IMAGE_DIMENSION_MAX
  )
    return null;
  return {
    mimeType,
    sizeBytes: bytes.byteLength,
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}
