import sharp from 'sharp';
export async function writeMipmaps(file, pixels) {
  for (const mip of [1, 2]) {
    await sharp(file).resize(pixels / 2 ** mip, pixels / 2 ** mip, { kernel: 'nearest' })
      .webp({ lossless: true }).toFile(file.replace(/\.webp$/, `-mip${mip}.webp`));
  }
}
