import sharp from 'sharp';

export const DEFAULT_LEARNING_SETTINGS = { enabled: false, budgetBytes: 1024 ** 3 };
export const LEARNING_MAX_BYTES = 200 * 1024;

/** Input is the actual scan crop. Only this bounded JPEG is retained or embedded. */
export async function compressLearningSample(image: Buffer, maxPixels = 60_000_000): Promise<Buffer> {
  const resized = await sharp(image, { limitInputPixels: maxPixels }).rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).toColourspace('srgb').png().toBuffer();
  for (const quality of [80, 70, 60]) {
    const jpeg = await sharp(resized).jpeg({ quality }).toBuffer();
    if (jpeg.length <= LEARNING_MAX_BYTES) return jpeg;
  }
  throw new Error('SAMPLE_TOO_LARGE');
}
