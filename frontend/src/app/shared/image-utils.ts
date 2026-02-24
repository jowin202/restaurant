const MAX_IMAGE_DIMENSION = 1600;
const TARGET_UPLOAD_BYTES = 1_600_000;
const SMALL_FILE_THRESHOLD = 1_000_000;

function scaleDimensions(width: number, height: number): { width: number; height: number } {
  const maxSide = Math.max(width, height);
  if (maxSide <= MAX_IMAGE_DIMENSION) {
    return { width, height };
  }

  const ratio = MAX_IMAGE_DIMENSION / maxSide;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Image conversion failed'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      quality
    );
  });
}

function normalizeFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim() || 'image';
  return `${base}.jpg`;
}

async function loadViaImageElement(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image decode failed'));
      el.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function isCompressibleImage(file: File): boolean {
  if (!file.type || !file.type.startsWith('image/')) return false;
  return file.type !== 'image/gif';
}

export async function prepareImageForUpload(file: File): Promise<File> {
  if (!isCompressibleImage(file)) {
    return file;
  }

  if (file.size <= SMALL_FILE_THRESHOLD && file.type === 'image/jpeg') {
    return file;
  }

  let sourceWidth = 0;
  let sourceHeight = 0;
  let draw: ((ctx: CanvasRenderingContext2D, width: number, height: number) => void) | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
      draw = (ctx, width, height) => ctx.drawImage(bitmap as ImageBitmap, 0, 0, width, height);
    } else {
      const image = await loadViaImageElement(file);
      sourceWidth = image.naturalWidth || image.width;
      sourceHeight = image.naturalHeight || image.height;
      draw = (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height);
    }

    if (!sourceWidth || !sourceHeight || !draw) {
      return file;
    }

    const { width, height } = scaleDimensions(sourceWidth, sourceHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return file;
    }

    draw(ctx, width, height);

    let quality = 0.86;
    let blob = await canvasToBlob(canvas, quality);

    while (blob.size > TARGET_UPLOAD_BYTES && quality > 0.56) {
      quality = Math.max(0.56, quality - 0.1);
      blob = await canvasToBlob(canvas, quality);
    }

    if (blob.size >= file.size && file.type === 'image/jpeg') {
      return file;
    }

    return new File([blob], normalizeFilename(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  } finally {
    if (bitmap) {
      bitmap.close();
    }
  }
}
