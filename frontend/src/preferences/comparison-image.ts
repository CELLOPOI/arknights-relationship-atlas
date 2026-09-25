import { assetUrl } from '../asset-url.ts';
import type { Appearance, Catalog } from './types';

export type ComparisonImage = { src: string; srcset?: string; sizes?: string };

export function comparisonImage(src: string, appearances: Catalog['appearances']): ComparisonImage {
  // 以原图 URL 精确匹配，旧题使用旧代表图，不能借用同人物的新形态或裁切半身图。
  const art = appearances.find(a => a.image_url === src);
  if (!art?.thumbnail_url || !art.width || !art.height
      || art.transform !== 'alpha-bounds-1600-webp86-thumb480x600-contain-v1') return { src: assetUrl(src) };
  const image: ComparisonImage = { src: assetUrl(art.thumbnail_url) };
  if (art.width && art.height && art.transform === 'alpha-bounds-1600-webp86-thumb480x600-contain-v1') {
    const scaled = art.width * Math.min(1, 480 / art.width, 600 / art.height);
    // 固定派生流程使用 libvips 的偶数舍入；w 描述符必须等于文件的真实像素宽。
    const width = scaled % 1 === 0.5 ? 2 * Math.round(scaled / 2) : Math.round(scaled);
    if (width < art.width) {
      image.srcset = `${image.src} ${width}w, ${assetUrl(src)} ${art.width}w`;
      image.sizes = comparisonSizes(art);
    }
  }
  return image;
}

function comparisonSizes(art: Appearance): string {
  const ratio = art.width! / art.height!;
  const height = (min: number, vh: number, max: number) => `clamp(${min * ratio}px, ${vh * ratio}dvh, ${max * ratio}px)`;
  // 与 random-pair / random-illustration 的宽高上限一致，按 contain 后实际图幅选清晰度。
  return `(max-height: 560px) and (orientation: landscape) min(calc((100vw - 130px) / 2), ${190 * ratio}px, 348px), `
    + `(max-width: 760px) min(calc((100vw - 106px) / 2), ${height(200, 32, 340)}), `
    + `min(calc((100vw - 228px) / 2), ${height(250, 43, 470)}, 508px)`;
}
